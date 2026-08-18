'use client';

// ============================================================
// CapiSettingsSection — Meta Conversions API credentials, rendered
// at the bottom of the WhatsApp settings panel (own Card, matching
// the panel's other cards).
//
// Token handling mirrors the WhatsApp access token: password-type
// input, write-only — after save the field clears and a "token
// saved" hint (from access_token_set) is shown instead. Submitting
// with the field blank keeps the stored token (server contract).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

interface CapiState {
  dataset_id: string | null;
  test_event_code: string | null;
  access_token_set: boolean;
  whatsapp_configured: boolean;
}

export function CapiSettingsSection({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations('Settings.capi');
  const [state, setState] = useState<CapiState | null>(null);
  const [datasetId, setDatasetId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [testEventCode, setTestEventCode] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/whatsapp/config/capi');
    if (!res.ok) return;
    const data = (await res.json()) as CapiState;
    setState(data);
    setDatasetId(data.dataset_id ?? '');
    setTestEventCode(data.test_event_code ?? '');
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/config/capi', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataset_id: datasetId.trim() || null,
          // blank = keep stored token (server contract)
          access_token: accessToken,
          test_event_code: testEventCode.trim() || null,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('saveFailed'));
        return;
      }
      toast.success(t('saved'));
      setAccessToken('');
      await load();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  if (!state) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t('title')}</CardTitle>
        <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {!state.whatsapp_configured ? (
          <p className="text-xs text-muted-foreground">{t('connectFirst')}</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('datasetId')}</Label>
              <Input
                value={datasetId}
                onChange={(e) => setDatasetId(e.target.value)}
                placeholder={t('datasetIdPlaceholder')}
                disabled={!isAdmin}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('accessToken')}</Label>
              <Input
                type="password"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder={
                  state.access_token_set
                    ? t('tokenSavedPlaceholder')
                    : t('tokenPlaceholder')
                }
                disabled={!isAdmin}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
              {state.access_token_set && (
                <p className="text-xs text-muted-foreground">{t('tokenSavedHint')}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('testEventCode')}</Label>
              <Input
                value={testEventCode}
                onChange={(e) => setTestEventCode(e.target.value)}
                placeholder={t('testEventCodePlaceholder')}
                disabled={!isAdmin}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
              <p className="text-xs text-muted-foreground">{t('testEventCodeHint')}</p>
            </div>
            {isAdmin && (
              <Button
                onClick={handleSave}
                disabled={saving}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {saving ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('saving')}
                  </>
                ) : (
                  t('save')
                )}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
