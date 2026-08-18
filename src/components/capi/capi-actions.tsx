'use client';

// ============================================================
// CapiActions — "Mark qualified" / "Mark converted" buttons, shared
// by the inbox contact sidebar and the contact detail view so the
// gating logic lives exactly once.
//
// Gating (spec docs/product/features/capi-events.md):
//   - no ctwa_clid on the contact         → disabled + reason
//   - account has no CAPI credentials     → disabled + reason
//   - already fired                        → inert state + "Fire again"
// Qualify confirms via window.confirm (no inputs); convert opens a
// Dialog collecting event name / value / currency. Failures leave
// the button active for manual retry — no queue by design.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Megaphone, RefreshCw } from 'lucide-react';

import type { Contact } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type ConvertEventName = 'Purchase' | 'Schedule';

interface FireResponse {
  event_id: string;
  event_name: string;
  fired_at: string;
  error?: string;
  code?: string;
}

// Mount with `key={contact.id}` from the parent (both call sites below do,
// belt-and-braces) — but the source of truth for the fired-state timestamps
// is the derived `qualifiedAt`/`convertedAt` below, not component identity.
// A successful fire sets a local override; absent an override we read
// straight from the `contact` prop, so a parent-driven prop update for the
// SAME contact id (e.g. the detail Sheet re-fetching) is picked up on the
// very next render — no effect, no ref access during render needed.
export function CapiActions({ contact }: { contact: Contact }) {
  const t = useTranslations('Contacts.capi');

  // Local overrides so a successful fire flips the UI without the
  // parent re-fetching the contact row. `null` means "no override yet" —
  // fall back to the prop's value, which stays live for prop updates.
  const [qualifiedOverride, setQualifiedOverride] = useState<string | null>(
    null
  );
  const [convertedOverride, setConvertedOverride] = useState<string | null>(
    null
  );
  const qualifiedAt = qualifiedOverride ?? contact.qualified_at ?? null;
  const convertedAt = convertedOverride ?? contact.converted_at ?? null;
  const [capiReady, setCapiReady] = useState<boolean | null>(null);
  const [firing, setFiring] = useState<'qualify' | 'convert' | null>(null);

  const [convertOpen, setConvertOpen] = useState(false);
  const [convertRefire, setConvertRefire] = useState(false);
  const [eventName, setEventName] = useState<ConvertEventName>('Purchase');
  const [value, setValue] = useState('');
  const [currency, setCurrency] = useState('INR');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/whatsapp/config/capi')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setCapiReady(Boolean(data.access_token_set && data.dataset_id));
      })
      .catch(() => {
        if (!cancelled) setCapiReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const hasClid = Boolean(contact.ctwa_clid);
  const blockedReason = !hasClid
    ? t('noClidHint')
    : capiReady === false
      ? t('noCredsHint')
      : null;
  const disabled = blockedReason != null || capiReady == null;

  const fire = useCallback(
    async (body: Record<string, unknown>): Promise<FireResponse | null> => {
      const res = await fetch(`/api/contacts/${contact.id}/capi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => ({}))) as FireResponse;
      if (!res.ok) {
        toast.error(payload.error || t('fireFailed'));
        return null;
      }
      return payload;
    },
    [contact.id, t]
  );

  async function handleQualify(refire: boolean) {
    if (!window.confirm(refire ? t('confirmQualifyAgain') : t('confirmQualify'))) return;
    setFiring('qualify');
    const result = await fire({ kind: 'qualify', refire });
    setFiring(null);
    if (result) {
      setQualifiedOverride(result.fired_at);
      toast.success(t('qualifiedToast'));
    }
  }

  function openConvert(refire: boolean) {
    setConvertRefire(refire);
    setEventName('Purchase');
    setValue('');
    setCurrency('INR');
    setConvertOpen(true);
  }

  async function handleConvertSubmit() {
    const trimmed = value.trim();
    let parsedValue: number | undefined;
    if (trimmed !== '') {
      parsedValue = Number(trimmed);
      if (!Number.isFinite(parsedValue) || parsedValue < 0) {
        toast.error(t('invalidValue'));
        return;
      }
    }
    if (!/^[A-Za-z]{3}$/.test(currency.trim())) {
      toast.error(t('invalidCurrency'));
      return;
    }
    setFiring('convert');
    const result = await fire({
      kind: 'convert',
      event_name: eventName,
      value: parsedValue,
      currency: parsedValue !== undefined ? currency.trim().toUpperCase() : undefined,
      refire: convertRefire,
    });
    setFiring(null);
    if (result) {
      setConvertedOverride(result.fired_at);
      setConvertOpen(false);
      toast.success(t('convertedToast'));
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Megaphone className="h-3 w-3" />
        {t('sectionTitle')}
      </div>

      {/* Qualify */}
      {qualifiedAt ? (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2 text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
            {t('qualifiedAt', { date: new Date(qualifiedAt).toLocaleDateString() })}
          </span>
          <button
            onClick={() => handleQualify(true)}
            disabled={disabled || firing != null}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
            title={t('fireAgain')}
          >
            <RefreshCw className="h-3 w-3" />
            {t('fireAgain')}
          </button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={disabled || firing != null}
          onClick={() => handleQualify(false)}
          title={blockedReason ?? undefined}
        >
          {firing === 'qualify' ? t('firing') : t('markQualified')}
        </Button>
      )}

      {/* Convert */}
      {convertedAt ? (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2 text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
            {t('convertedAt', { date: new Date(convertedAt).toLocaleDateString() })}
          </span>
          <button
            onClick={() => openConvert(true)}
            disabled={disabled || firing != null}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
            title={t('fireAgain')}
          >
            <RefreshCw className="h-3 w-3" />
            {t('fireAgain')}
          </button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={disabled || firing != null}
          onClick={() => openConvert(false)}
          title={blockedReason ?? undefined}
        >
          {firing === 'convert' ? t('firing') : t('markConverted')}
        </Button>
      )}

      {blockedReason && (
        <p className="px-1 text-xs text-muted-foreground">{blockedReason}</p>
      )}

      <Dialog open={convertOpen} onOpenChange={setConvertOpen}>
        <DialogContent className="bg-popover border-border sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {convertRefire ? t('convertAgainTitle') : t('convertTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('convertDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('eventName')}</Label>
              <Select
                value={eventName}
                onValueChange={(v) => v && setEventName(v as ConvertEventName)}
              >
                <SelectTrigger className="w-full bg-muted border-border text-foreground">
                  <SelectValue>{eventName}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Purchase">Purchase</SelectItem>
                  <SelectItem value="Schedule">Schedule</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">
                {t('value')}{' '}
                <span className="text-xs">{t('optional')}</span>
              </Label>
              <Input
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="0.00"
                className="bg-muted border-border text-foreground"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('currency')}</Label>
              <Input
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                maxLength={3}
                className="bg-muted border-border text-foreground"
              />
            </div>
          </div>

          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setConvertOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleConvertSubmit}
              disabled={firing != null}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {firing === 'convert' ? t('firing') : t('fireEvent')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
