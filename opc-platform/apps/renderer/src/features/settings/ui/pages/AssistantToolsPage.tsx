import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssistantSearchProvider, AssistantToolsSettings } from '@opc/shared/ipc';
import { buttonClass, PageHeader, Row, SecretField, Section, SelectField, TextField, Toggle } from '../kit';
import { setAppTimeZone } from '@/shared/lib/appTime';

const PROVIDERS: AssistantSearchProvider[] = ['exa', 'tavily', 'firecrawl'];
const CITIES = [
  ['Shanghai', '上海 / Shanghai'], ['Beijing', '北京 / Beijing'], ['Shenzhen', '深圳 / Shenzhen'],
  ['Hangzhou', '杭州 / Hangzhou'], ['Guangzhou', '广州 / Guangzhou'], ['Chengdu', '成都 / Chengdu'],
  ['Hong Kong', '香港 / Hong Kong'], ['Taipei', '台北 / Taipei'], ['Tokyo', '东京 / Tokyo'],
  ['Singapore', '新加坡 / Singapore'], ['New York', '纽约 / New York'], ['London', '伦敦 / London'],
] as const;
const TIMEZONES = [
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Kolkata', 'Europe/London',
  'Europe/Paris', 'America/Los_Angeles', 'America/Denver', 'America/Chicago',
  'America/New_York', 'Australia/Sydney',
] as const;

export function AssistantToolsPage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AssistantToolsSettings | null>(null);
  const [timezone, setTimezone] = useState('');
  const [city, setCity] = useState('');
  const [customTimezone, setCustomTimezone] = useState(false);
  const [customCity, setCustomCity] = useState(false);
  const [provider, setProvider] = useState<AssistantSearchProvider | ''>('');
  const [enabled, setEnabled] = useState<Record<AssistantSearchProvider, boolean>>({ exa: false, tavily: false, firecrawl: false });
  const [keys, setKeys] = useState<Partial<Record<AssistantSearchProvider, string>>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.opc?.assistantTools.getSettings().then((value) => {
      if (cancelled) return;
      setSettings(value);
      setTimezone(value.timezone ?? '');
      setCustomTimezone(Boolean(value.timezone && !TIMEZONES.includes(value.timezone as (typeof TIMEZONES)[number])));
      setAppTimeZone(value.timezone);
      setCity(value.weatherCity);
      setCustomCity(Boolean(value.weatherCity && !CITIES.some(([name]) => name === value.weatherCity)));
      setKeys(value.keys);
      setEnabled(value.enabled);
      setProvider(value.configured[value.defaultSearch] && value.enabled[value.defaultSearch]
        ? value.defaultSearch
        : PROVIDERS.find((name) => value.configured[name] && value.enabled[name]) ?? '');
    }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)));
    return () => { cancelled = true; };
  }, []);

  const availableProviders = PROVIDERS.filter((name) =>
    enabled[name] && (settings?.configured[name] || Boolean(keys[name]?.trim())),
  );

  const save = async () => {
    if (saving || !settings) return;
    setSaving(true);
    setMessage('');
    setSaveFailed(false);
    try {
      const value = await window.opc!.assistantTools.updateSettings({
        timezone: timezone.trim() || null,
        weatherCity: city,
        ...(provider ? { defaultSearch: provider } : {}),
        enabled,
        keys: Object.fromEntries(PROVIDERS.filter((name) => keys[name]?.trim()).map((name) => [name, keys[name]!.trim()])),
      });
      setSettings(value);
      setAppTimeZone(value.timezone);
      setKeys(value.keys);
      setMessage(t('settings.assistantTools.saved'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setSaveFailed(true);
    } finally { setSaving(false); }
  };

  return <>
    <PageHeader crumbs={[t('settings.group.network'), t('settings.page.assistantTools')]} title={t('settings.page.assistantTools')} description={t('settings.assistantTools.description')} actions={<button type="button" className={buttonClass.primary} disabled={!settings || saving} onClick={() => void save()}>{saving ? t('common.saving') : t('common.save')}</button>} />
    {message ? <p role="status" className={`mb-3 text-sm ${saveFailed ? 'text-danger' : 'text-success'}`}>{message}</p> : null}
    <div className="space-y-4">
      <Section title={t('settings.assistantTools.localTitle')} description={t('settings.assistantTools.localDescription')}>
        <Row label={t('settings.assistantTools.timezone')} hint={t('settings.assistantTools.timezoneHint')}>
          <div className="w-64">
            <SelectField
              ariaLabel={t('settings.assistantTools.timezone')}
              value={customTimezone ? 'custom' : timezone}
              onChange={(value) => {
                setCustomTimezone(value === 'custom');
                if (value !== 'custom') setTimezone(value);
              }}
            >
              <option value="">{t('settings.theme.system')}</option>
              {TIMEZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
              <option value="custom">{t('settings.assistantTools.custom')}</option>
            </SelectField>
            {customTimezone ? <TextField ariaLabel={t('settings.assistantTools.customTimezone')} value={timezone} onChange={setTimezone} placeholder="America/Los_Angeles" className="mt-2" /> : null}
          </div>
        </Row>
        <Row label={t('settings.assistantTools.city')} hint={t('settings.assistantTools.cityHint')}>
          <div className="w-64">
            <SelectField
              ariaLabel={t('settings.assistantTools.city')}
              value={customCity ? 'custom' : city}
              onChange={(value) => {
                setCustomCity(value === 'custom');
                if (value !== 'custom') setCity(value);
              }}
            >
              <option value="">{t('settings.assistantTools.noDefaultCity')}</option>
              {CITIES.map(([name, label]) => <option key={name} value={name}>{label}</option>)}
              <option value="custom">{t('settings.assistantTools.custom')}</option>
            </SelectField>
            {customCity ? <TextField ariaLabel={t('settings.assistantTools.customCity')} value={city} onChange={setCity} placeholder={t('settings.assistantTools.cityPlaceholder')} className="mt-2" /> : null}
          </div>
        </Row>
      </Section>
      <Section title={t('settings.assistantTools.searchTitle')} description={t('settings.assistantTools.searchDescription')}>
        <Row label={t('settings.assistantTools.defaultProvider')} hint={t('settings.assistantTools.failoverHint')}>
          <SelectField ariaLabel={t('settings.assistantTools.defaultProvider')} value={provider} onChange={(value) => setProvider(value as AssistantSearchProvider | '')} className="w-48">
            <option value="">{availableProviders.length ? t('settings.assistantTools.chooseProvider') : t('settings.assistantTools.noEnabledProvider')}</option>
            {availableProviders.map((name) => <option key={name} value={name}>{name}</option>)}
          </SelectField>
        </Row>
        {PROVIDERS.map((name) => <Row
          key={name}
          label={name}
          hint={settings?.configured[name] || keys[name]?.trim() ? t('settings.assistantTools.configured') : t('settings.assistantTools.keyRequired')}
        >
          <div className="flex w-[24rem] max-w-[52vw] shrink-0 items-center justify-end gap-3">
            <div className="min-w-0 flex-1">
              <SecretField ariaLabel={`${name} API Key`} value={keys[name] ?? ''} onChange={(value) => setKeys((current) => ({ ...current, [name]: value }))} placeholder={t('settings.assistantTools.keyPlaceholder')} />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Toggle
                label={`${name} ${t('settings.assistantTools.enable')}`}
                checked={enabled[name]}
                disabled={!settings?.configured[name] && !keys[name]?.trim()}
                onChange={(checked) => {
                  setEnabled((current) => ({ ...current, [name]: checked }));
                  const nextAvailable = PROVIDERS.filter((item) => item === name
                    ? checked && (settings?.configured[item] || Boolean(keys[item]?.trim()))
                    : enabled[item] && (settings?.configured[item] || Boolean(keys[item]?.trim())));
                  if (!checked && provider === name) setProvider(nextAvailable[0] ?? '');
                  if (checked && !provider && (settings?.configured[name] || keys[name]?.trim())) setProvider(name);
                }}
              />
              <span className="text-xs text-ink-secondary">{t('settings.assistantTools.enable')}</span>
            </div>
          </div>
        </Row>)}
      </Section>
      <p className="text-xs leading-relaxed text-ink-tertiary">{t('settings.assistantTools.toolsNote')}</p>
    </div>
  </>;
}
