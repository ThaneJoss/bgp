import { test as base, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { compress, fixture } from '../bgp/fixtures.mjs';

// Keep every request on the local production server. In particular, a test
// regression must never start the large RouteViews download relay.
const test = base.extend<{ localRequests: string[] }>({
  localRequests: [async ({ context }, use) => {
    const requests: string[] = [];
    const blocked: string[] = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://127.0.0.1:4173' || url.pathname === '/api/bgp/download') {
        blocked.push(url.href);
        await route.abort();
        return;
      }
      requests.push(url.pathname);
      await route.continue();
    });
    await use(requests);
    expect(blocked, 'The browser must not request external resources or the BGP relay').toEqual([]);
  }, { auto: true }],
});

async function accessibleAndFits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No horizontal page overflow').toBe(true);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations).toEqual([]);
}

async function capturePage(page: Page, path: string) {
  // axe may probe focusable controls; reset focus and scroll for review images.
  await page.getByRole('main').focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path, fullPage: true });
}

test('manual topology loading, keyboard navigation and responsive pages', async ({ page, localRequests }, testInfo) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳至主要内容' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await expect(page.getByRole('link', { name: '全球拓扑', exact: true })).toHaveAttribute('aria-current', 'page');
  await accessibleAndFits(page);
  expect(localRequests.filter(path => path.startsWith('/data/') || path.startsWith('/api/bgp/'))).toEqual([]);

  await page.getByRole('button', { name: '获取拓扑数据', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全球网络', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: /全球网络，.*个节点/ })).toBeVisible();
  expect(localRequests).toContain('/data/explorer/overview.json');
  await accessibleAndFits(page);
  await capturePage(page, testInfo.outputPath('topology.png'));
  await page.getByRole('button', { name: '放大地图', exact: true }).click();
  await expect(page.locator('.atlas-map-tools')).toContainText('140%');
  await page.locator('.atlas-node-list button').first().click();
  await expect(page.getByText('第 2 层 · 社区区块', { exact: true })).toBeVisible();
  await expect(page.locator('.atlas-map-tools')).toContainText('100%');
  await page.getByRole('button', { name: '返回全球网络', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全球网络', exact: true })).toBeVisible();

  await page.getByRole('link', { name: '路径对比', exact: true }).click();
  await expect(page).toHaveURL(/\/paths$/);
  await expect(page.getByRole('link', { name: '路径对比', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: '请先获取数据' })).toBeDisabled();
  await accessibleAndFits(page);

  await page.getByRole('button', { name: '来源与说明', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  // Visibility can precede the fade-in finishing; axe needs the final colors.
  await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
  await accessibleAndFits(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '来源与说明', exact: true })).toBeFocused();
});

test('production browser Worker imports synthetic MRT and preserves data after errors', async ({ page }, testInfo) => {
  await page.goto('/paths');
  await page.getByLabel('导入 MRT 文件').setInputFiles({ name: 'synthetic-rib.bz2', mimeType: 'application/octet-stream', buffer: compress(fixture()) });
  await expect(page.getByRole('status').filter({ hasText: '解析完成：6 条路由' })).toBeVisible();
  await page.getByRole('button', { name: '对比路径', exact: true }).click();
  await expect(page.getByText('先共同经过 1 个网络，再分别前往两个目标。', { exact: true })).toBeVisible();
  await expect(page.locator('.path-network[href="/?asn=3491"]')).toHaveCount(1);
  await expect(page.locator('.path-network[href="/?asn=13335"]')).toBeVisible();
  await expect(page.locator('.path-network[href="/?asn=15169"]')).toBeVisible();
  await accessibleAndFits(page);
  await capturePage(page, testInfo.outputPath('synthetic-paths.png'));
  const observer = page.getByRole('combobox', { name: '切换第三方观测视角' });
  await expect(observer.locator('option')).toHaveCount(2);
  await observer.selectOption({ label: 'AS3491 · IPv6 · 2001:7fa:0:1::ca28:a0f4' });
  await expect(page.getByRole('heading', { name: '没有共同的观测点', exact: true })).toBeVisible();
  await expect(page.getByText('当前观测视角未收录其中一种 IP 协议。请选择其他视角。', { exact: false })).toBeVisible();
  await accessibleAndFits(page);
  await observer.selectOption({ label: 'AS3491 · IPv4 · 123.255.90.244' });
  await expect(page.locator('.path-network[href="/?asn=13335"]')).toBeVisible();

  await page.getByLabel('目标 IP A', { exact: true }).fill('invalid-ip');
  await page.getByRole('button', { name: '对比路径', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('暂时无法显示路径');
  await page.getByLabel('目标 IP A', { exact: true }).fill('1.1.1.1');
  await page.getByRole('button', { name: '重新查询', exact: true }).click();
  await expect(page.locator('.path-network[href="/?asn=13335"]')).toBeVisible();

  await page.getByLabel('导入 MRT 文件').setInputFiles({ name: 'truncated.mrt', mimeType: 'application/octet-stream', buffer: fixture().subarray(0, 15) });
  await expect(page.getByRole('alert')).toContainText('当前已加载的数据仍可查询。');
  await page.getByRole('button', { name: '对比路径', exact: true }).click();
  await expect(page.locator('.path-network[href="/?asn=13335"]')).toBeVisible();
  await expect(page.locator('.path-network[href="/?asn=15169"]')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '请先获取数据' })).toBeDisabled();
});
