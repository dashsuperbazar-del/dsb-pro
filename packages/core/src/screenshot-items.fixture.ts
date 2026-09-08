export const SCREENSHOT_ITEMS = {
  pp3x3: {
    name: '3x3 PP poly', unit1: 'Kg', unit2: 'Gms', unit3: '', conv1: 1000, conv2: 1,
    priceUnit: '1' as const, retailPaise: 24000, wholesaleSalePaise: 24000, wholesaleQty: 1,
    purchasePaise: 20800, taxRateBps: 0,
  },
  pp5x6: {
    name: '5X6 PP poly', unit1: 'Kg', unit2: 'Gms', unit3: '', conv1: 1000, conv2: 1,
    priceUnit: '2' as const, retailPaise: 24, wholesaleSalePaise: 22, wholesaleQty: 1,
    purchasePaise: 19700, taxRateBps: 0,
  },
  butterBake: {
    name: 'Anmol Butter bake biscuit 10/-', unit1: 'ctn', unit2: 'Pcs', unit3: '', conv1: 40, conv2: 1,
    priceUnit: '2' as const, retailPaise: 1000, wholesaleSalePaise: 10800, wholesaleQty: 12,
    purchasePaise: 33500, taxRateBps: 0,
  },
  marie: {
    name: 'Anmol marie biscuit 5/-', unit1: 'Ctn', unit2: 'Pkt', unit3: 'Pcs', conv1: 12, conv2: 12,
    priceUnit: '3' as const, retailPaise: 500, wholesaleSalePaise: 5400, wholesaleQty: 12,
    purchasePaise: 58300, taxRateBps: 0,
  },
  honey: {
    name: 'Apis Honey 10/-', unit1: 'pcs', unit2: '', unit3: '', conv1: 1, conv2: 1,
    priceUnit: '1' as const, retailPaise: 1000, wholesaleSalePaise: 900, wholesaleQty: 1,
    purchasePaise: 750, taxRateBps: 0,
  },
  atta: {
    name: 'Ashrivaad Atta 5kg', unit1: 'Pcs', unit2: '', unit3: '', conv1: 1, conv2: 1,
    priceUnit: '1' as const, retailPaise: 25000, wholesaleSalePaise: 24000, wholesaleQty: 1,
    purchasePaise: 22651, taxRateBps: 500,
  },
} as const;
