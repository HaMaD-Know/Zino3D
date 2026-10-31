import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const fixture = (name: string) => fileURLToPath(new URL(`../tests/fixtures/${name}`, import.meta.url));

async function newProject(page: Page, name = 'E2E project') {
  await page.goto('/');
  await page
    .getByRole('button', { name: /New project/ })
    .first()
    .click();
  const input = page.getByRole('dialog').getByLabel('Project name');
  await input.fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('.viewport-canvas')).toBeVisible();
}

async function importFile(page: Page, ...names: string[]) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import 3D model' }).first().click();
  await (await chooser).setFiles(names.map(fixture));
}

test.beforeEach(async ({ page }) => {
  // Each test starts with empty local storage (IndexedDB is per browser context).
  page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
});

test('home screen shows the empty state and branding', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Zino3D' })).toBeVisible();
  await expect(page.getByText('No projects yet')).toBeVisible();
  await expect(page.getByRole('button', { name: /Sample project/ })).toBeVisible();
});

test('import GLB, inspect hierarchy, rename with undo/redo', async ({ page }) => {
  await newProject(page);
  await importFile(page, 'multimesh.glb');
  const dialog = page.getByRole('dialog', { name: /Imported multimesh.glb/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Meshes')).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();

  const tree = page.getByRole('tree', { name: 'Scene hierarchy' });
  await expect(tree.getByText('Ball', { exact: true })).toBeVisible();
  await tree.getByText('Ball', { exact: true }).click();
  const nameField = page.getByLabel('Object name');
  await expect(nameField).toHaveValue('Ball');
  await nameField.fill('Front Wheel');
  await nameField.press('Enter');
  await expect(tree.getByText('Front Wheel')).toBeVisible();

  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect(tree.getByText('Ball', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Redo/ }).click();
  await expect(tree.getByText('Front Wheel')).toBeVisible();
});

test('numeric transform edits update the object and can be undone', async ({ page }) => {
  await newProject(page);
  await importFile(page, 'cube.glb');
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('tree').getByText('Cube', { exact: true }).click();
  const x = page.getByLabel('Position X');
  await x.fill('2.5');
  await x.press('Enter');
  await expect(x).toHaveValue('2.5');
  await page.keyboard.press('Control+z');
  await expect(x).toHaveValue('0');
});

test('separate loose parts of a car and export GLB', async ({ page }) => {
  await newProject(page);
  await importFile(page, 'car-loose-wheels.glb');
  await page.getByRole('button', { name: 'Done' }).click();
  const tree = page.getByRole('tree');
  await tree.getByText('Car', { exact: true }).click();
  await page.getByRole('button', { name: 'Separate parts' }).click();
  await expect(tree.getByText('Car.part5')).toBeVisible();
  await expect(page.locator('.tree__row')).toHaveCount(7); // group + 6 parts

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Export model' });
  await exportDialog.getByLabel('File name').fill('car-parts');
  const download = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('car-parts.glb');
  const bytes = readFileSync(await file.path());
  expect(bytes.subarray(0, 4).toString()).toBe('glTF');
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
  expect(json.meshes.length).toBe(6);
});

test('wheel assistant separates the four wheels', async ({ page }) => {
  await newProject(page);
  await importFile(page, 'car-loose-wheels.glb');
  await page.getByRole('dialog').getByRole('button', { name: 'Open wheel & parts assistant' }).click();
  const dialog = page.getByRole('dialog', { name: /Parts of "Car"/ });
  await expect(dialog.getByText('Found 6 disconnected parts')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Separate 4 part(s)' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Separate 4 part(s)' }).click();
  const tree = page.getByRole('tree');
  for (const n of [1, 2, 3, 4]) await expect(tree.getByText(`Wheel_${n}`)).toBeVisible();
});

test('rejects malformed and unsupported files with a clear message', async ({ page }) => {
  await newProject(page);
  await importFile(page, 'malformed.glb');
  await expect(page.getByText(/not a valid GLB/)).toBeVisible();
  await importFile(page, 'unsupported.xyz');
  await expect(page.getByText(/Unsupported file type/)).toBeVisible();
});

test('projects autosave and survive a reload', async ({ page }) => {
  await newProject(page, 'Persistent');
  await importFile(page, 'cube.glb');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.save-status')).toHaveText(/Saved/, { timeout: 15_000 });
  await page.reload();
  await page.getByRole('button', { name: 'Open Persistent' }).click();
  await expect(page.getByRole('tree').getByText('Cube', { exact: true })).toBeVisible();
});

test('edit mode face selection and separation', async ({ page }) => {
  await newProject(page);
  await importFile(page, 'cube.glb');
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('tree').getByText('Cube', { exact: true }).click();
  await page.keyboard.press('Tab');
  await expect(page.getByText(/Edit Mode · Cube/)).toBeVisible();
  await page.keyboard.press('3');
  // Select the face under the viewport centre (the framed cube).
  const box = (await page.locator('.viewport-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByText(/1 face\(s\) selected/)).toBeVisible();
  await page.getByRole('button', { name: 'Separate selection into new object' }).click();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tree').getByText('Cube.separated')).toBeVisible();
});

test('@responsive layout adapts and panels open as drawers', async ({ page, viewport }) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: /Sample project/ })
    .first()
    .click();
  await expect(page.locator('.viewport-canvas')).toBeVisible();
  const editor = page.locator('.editor');
  if ((viewport?.width ?? 1440) < 1100) {
    await expect(editor).toHaveAttribute('data-layout', 'compact');
    await expect(editor).toHaveAttribute('data-left', 'closed');
    await page.getByRole('button', { name: 'Scene hierarchy' }).click();
    await expect(editor).toHaveAttribute('data-left', 'open');
    await expect(page.getByRole('tree').getByText('Car', { exact: true })).toBeVisible();
    await page.getByRole('tree').getByText('Car', { exact: true }).click();
    await page.getByRole('button', { name: 'Properties' }).click();
    await expect(editor).toHaveAttribute('data-right', 'open');
    await expect(editor).toHaveAttribute('data-left', 'closed');
    await expect(page.getByLabel('Object name')).toHaveValue('Car');
  } else {
    await expect(editor).toHaveAttribute('data-layout', 'full');
    await expect(page.getByRole('tree')).toBeVisible();
  }
  // No horizontal page overflow at any size.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.waitForTimeout(400); // let drawer transitions finish
  await page.screenshot({ path: `test-results/layout-${viewport?.width}.png` });
});
