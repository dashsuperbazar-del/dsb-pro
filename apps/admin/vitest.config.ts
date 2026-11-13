import { mergeConfig } from 'vite';
import viteConfig from './vite.config.ts';

// Unit-test settings on top of the app's Vite config.
export default mergeConfig(viteConfig, {
  test: { setupFiles: ['./src/test-setup.ts'] },
});
