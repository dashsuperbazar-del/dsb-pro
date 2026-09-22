import { test, expect } from '@playwright/test';

const PASSWORD='TestOnly-2026!pw';
function uniqueEmail(){return `pos-cart-${Date.now()}-${Math.floor(Math.random()*1e6)}@example.com`;}
async function createOwnerShop(page:import('@playwright/test').Page){
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password',{exact:true}).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button',{name:'Sign up'}).click();
  await expect(page.getByRole('heading',{name:'Welcome'})).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('POS Cart Shop');
  await page.getByRole('button',{name:'Create your shop'}).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
}
async function createItemWithStock(page:import('@playwright/test').Page,name:string,priceRupees:string,stockQty:string){
  await page.getByPlaceholder('Item name').fill(name);
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button',{name:'Create item'}).click();
  await expect(page.getByRole('status')).toContainText(`Created ${name}`);
  await page.getByLabel('Peek item').selectOption({label:name});
  const priceForm=page.getByRole('button',{name:'Set price'}).locator('xpath=..');
  await priceForm.locator('input[name="price"]').fill(priceRupees);
  await page.getByRole('button',{name:'Set price'}).click();
  const purchase=page.locator('section').filter({has:page.getByRole('heading',{name:'Post purchase'})});
  await purchase.locator('select[name="itemId"]').selectOption({label:name});
  await purchase.locator('input[name="qty"]').fill(stockQty);
  await purchase.locator('input[name="price"]').fill(priceRupees);
  await purchase.getByRole('button',{name:'Add line'}).click();
  await purchase.getByRole('button',{name:'Post purchase'}).click();
  await expect(page.getByRole('status')).toContainText('Purchase posted (1 line) and stock updated');
}

test('cart lines edit in place, and a held cart survives being parked and comes back finalizable',async({page})=>{
  test.setTimeout(60000);
  await createOwnerShop(page);
  await page.getByRole('link',{name:'Inventory & purchases'}).click();
  await createItemWithStock(page,'Cart Edit Item A','10','5');
  await createItemWithStock(page,'Cart Edit Item B','20','5');

  await page.goto('/pos');
  const cartSection=page.locator('section').filter({has:page.getByRole('heading',{name:'2. Cart'})});

  await page.getByLabel('Find product').fill('Cart Edit Item A');
  await expect(page.getByLabel('Item').locator('option')).toHaveCount(2);
  await page.getByLabel('Item').selectOption({index:1});
  await page.getByTestId('pos-add-quantity').fill('2');
  await page.getByRole('button',{name:'Add line'}).click();
  await expect(page.getByRole('cell',{name:/Cart Edit Item A/})).toBeVisible();
  await expect(cartSection).toContainText('₹20.00');

  // Editing quantity in place recomputes the line and preview totals.
  await page.getByLabel('Cart qty for Cart Edit Item A').fill('3');
  await expect(cartSection).toContainText('₹30.00');

  // Editing the line discount in place does too.
  await page.getByLabel('Discount for Cart Edit Item A').fill('5');
  await expect(cartSection).toContainText('₹25.00');

  // Hold the cart. It must clear the active cart without losing the edits.
  await page.getByTestId('pos-hold-label').fill('Table 3');
  await page.getByRole('button',{name:'Hold cart'}).click();
  await expect(page.getByText('Cart is empty.')).toBeVisible();
  const heldSection=page.locator('section[aria-label="Held carts"]');
  await expect(heldSection).toContainText('Table 3');
  await page.reload();
  await expect(heldSection).toContainText('Table 3');

  // A second, throwaway hold proves discard removes only the intended one.
  await page.getByLabel('Find product').fill('Cart Edit Item B');
  await page.getByLabel('Item').selectOption({index:1});
  await page.getByTestId('pos-add-quantity').fill('1');
  const holdLabel=page.getByTestId('pos-hold-label');
  await holdLabel.evaluate(node=>node.setAttribute('data-race-sentinel','same-node'));
  await page.getByRole('button',{name:'Add line'}).click();
  await holdLabel.fill('Temp Cart');
  // The add-line price lookup resolves asynchronously. Its later cart render
  // must preserve the same input node and its freshly typed label.
  await expect(page.getByRole('cell',{name:/Cart Edit Item B/})).toBeVisible();
  await expect(holdLabel).toHaveAttribute('data-race-sentinel','same-node');
  await expect(holdLabel).toHaveValue('Temp Cart');
  await page.getByRole('button',{name:'Hold cart'}).click();
  await expect(heldSection.locator('tr').filter({hasText:'Temp Cart'})).toBeVisible();
  await heldSection.locator('tr').filter({hasText:'Temp Cart'}).getByRole('button',{name:'Discard'}).click();
  await expect(heldSection.locator('tr').filter({hasText:'Temp Cart'})).toHaveCount(0);
  await expect(heldSection).toContainText('Table 3');

  // A held cart does not block billing a different customer in the meantime.
  await page.getByLabel('Find product').fill('Cart Edit Item B');
  await page.getByLabel('Item').selectOption({index:1});
  await page.getByTestId('pos-add-quantity').fill('1');
  await page.getByRole('button',{name:'Add line'}).click();
  await page.getByLabel('Amount ₹').first().fill('20');
  await page.getByRole('button',{name:'Finalize sale'}).click();
  await expect(page.getByRole('status')).toContainText('Sale finalized');

  // Resume restores the exact edited quantity/discount, not the original add.
  // A double click must still yield one claimant, one active cart and one
  // cleanup. The Dexie token is the authority; button disabling is only UX.
  await page.getByRole('button',{name:'Resume Table 3'}).dblclick();
  await expect(page.getByRole('status')).toContainText('Cart resumed');
  await expect(page.getByRole('cell',{name:/Cart Edit Item A/})).toBeVisible();
  await expect(cartSection.locator('tbody tr')).toHaveCount(1);
  await expect(cartSection).toContainText('₹25.00');
  await expect(heldSection).toHaveCount(0);

  await page.getByLabel('Amount ₹').first().fill('25');
  await page.getByRole('button',{name:'Finalize sale'}).click();
  await expect(page.getByRole('status')).toContainText('Sale finalized');
});
