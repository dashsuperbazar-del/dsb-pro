import { useState } from 'preact/hooks';
const key = 'dsb-pro:appearance';
type Theme = 'system' | 'light' | 'dark';
export function readTheme(): Theme {
  try {
    const value = localStorage.getItem(key);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}
export function applyTheme(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
export function ThemeToggle() {
  const [theme, setTheme] = useState(readTheme);
  return (
    <label>
      Appearance
      <select
        value={theme}
        onChange={(event) => {
          const next = event.currentTarget.value as Theme;
          setTheme(next);
          applyTheme(next);
          try {
            localStorage.setItem(key, next);
          } catch {
            /* preference can still apply for this visit */
          }
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
