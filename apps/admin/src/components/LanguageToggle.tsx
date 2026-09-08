import { useState } from 'preact/hooks';
import { getLocale, setLocale, t, type Locale } from '../lib/i18n';

export function LanguageToggle(){
  const [locale,setCurrent]=useState<Locale>(getLocale());
  function change(next:Locale){ setLocale(next); setCurrent(next); window.dispatchEvent(new Event('dsb-locale-change')); }
  return <label>{t('language',locale)} <select aria-label="Language" value={locale} onChange={e=>change((e.currentTarget as HTMLSelectElement).value as Locale)}><option value="en">English</option><option value="hi">हिन्दी</option></select></label>;
}
