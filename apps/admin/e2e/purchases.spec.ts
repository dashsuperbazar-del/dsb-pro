import { test, expect } from '@playwright/test';

const PASSWORD='TestOnly-2026!pw';
function uniqueEmail(){return `purchases-${Date.now()}-${Math.floor(Math.random()*1e6)}@example.com`;}
async function createOwnerShop(page:import('@playwright/test').Page){
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password',{exact:true}).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button',{name:'Sign up'}).click();
  await expect(page.getByRole('heading',{name:'Welcome'})).toBeVisible();
  await page.goto('/');
  await page.getByLabel('Shop name').fill('Multi-line Purchase Shop');
  await page.getByRole('button',{name:'Create your shop'}).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
}
async function createItem(page:import('@playwright/test').Page,name:string){
  await page.getByPlaceholder('Item name').fill(name);
  await page.getByPlaceholder('Big unit (e.g. case)').fill('piece');
  await page.getByRole('button',{name:'Create item'}).click();
  await expect(page.getByRole('status')).toContainText(`Created ${name}`);
}

test('a single supplier bill can carry more than one purchase line',async({page})=>{
  await createOwnerShop(page);
  await page.getByRole('link',{name:'Inventory & purchases'}).click();
  await createItem(page,'Purchase Line Item A');
  await createItem(page,'Purchase Line Item B');

  const purchase=page.locator('section').filter({has:page.getByRole('heading',{name:'Post purchase'})});
  await expect(purchase.getByRole('button',{name:'Post purchase'})).toBeDisabled();

  await purchase.locator('select[name="itemId"]').selectOption({label:'Purchase Line Item A'});
  await purchase.locator('input[name="qty"]').fill('4');
  await purchase.locator('input[name="price"]').fill('10');
  await purchase.getByRole('button',{name:'Add line'}).click();
  await expect(purchase.locator('table tbody tr')).toHaveCount(1);
  // The item picker resets after each add, so a second line can target a different item.
  await purchase.locator('select[name="itemId"]').selectOption({label:'Purchase Line Item B'});
  await purchase.locator('input[name="qty"]').fill('6');
  await purchase.locator('input[name="price"]').fill('5');
  await purchase.getByRole('button',{name:'Add line'}).click();
  await expect(purchase.locator('table tbody tr')).toHaveCount(2);
  await expect(purchase).toContainText('Lines total: ₹70.00');

  // A line can be dropped before posting without disturbing the other line's total.
  await purchase.getByRole('button',{name:'Remove purchase line 1'}).click();
  await expect(purchase.locator('table tbody tr')).toHaveCount(1);
  await expect(purchase).toContainText('Lines total: ₹30.00');

  // Re-add the first line so the posted bill genuinely carries both items.
  await purchase.locator('select[name="itemId"]').selectOption({label:'Purchase Line Item A'});
  await purchase.locator('input[name="qty"]').fill('4');
  await purchase.locator('input[name="price"]').fill('10');
  await purchase.getByRole('button',{name:'Add line'}).click();
  await expect(purchase.locator('table tbody tr')).toHaveCount(2);
  await expect(purchase).toContainText('Lines total: ₹70.00');

  await purchase.locator('input[name="billNo"]').fill('MULTI-1');
  await purchase.getByRole('button',{name:'Post purchase'}).click();
  await expect(page.getByRole('status')).toContainText('Purchase posted (2 lines) and stock updated');
  await expect(purchase.locator('table tbody tr')).toHaveCount(0);

  await page.getByLabel('Peek item').selectOption({label:'Purchase Line Item A'});
  await expect(page.getByLabel('item peek')).toContainText('Stock 4 piece');
  await page.getByLabel('Peek item').selectOption({label:'Purchase Line Item B'});
  await expect(page.getByLabel('item peek')).toContainText('Stock 6 piece');
});
