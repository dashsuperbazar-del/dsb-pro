const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

export function appPath(path = '/') {
  if (!path.startsWith('/')) throw new Error('appPath expects an absolute app path');
  return `${basePath}${path}` || '/';
}

export const appRoute = {
  home: appPath('/'),
  signup: appPath('/signup'),
  join: appPath('/join/:token?'),
  team: appPath('/team'),
  devices: appPath('/devices'),
  inventory: appPath('/inventory'),
  pos: appPath('/pos'),
  customers: appPath('/customers'),
  salesHistory: appPath('/sales-history'),
};
