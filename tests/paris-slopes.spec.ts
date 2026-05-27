/**
 * Paris slope regression tests.
 *
 * These tests verify that the slope map shows sensible values at well-known
 * Paris locations.  They serve as both living documentation of expected
 * behaviour and regression guards against future changes.
 *
 * How slope is computed in this app
 * ----------------------------------
 * 1. AWS Terrarium elevation tiles are decoded to a floating-point elevation
 *    buffer.
 * 2. The gradient magnitude |∇z| is computed per-pixel and multiplied by 100
 *    to give % grade.
 * 3. A road mask rasterises MapLibre road features so only road pixels are
 *    coloured.
 * 4. The ramp is blue (flat) → yellow → red (steep), normalised to the 98th
 *    percentile of visible road slopes.
 *
 * Known bug (tracked here)
 * ------------------------
 * Roads running along the Seine banks (Quai de la Tournelle, Quai Branly …)
 * appear in vivid red/orange because the elevation gradient at those pixels
 * is dominated by the vertical embankment wall beside them, not the road's
 * longitudinal grade.  The fix is to project |∇z| onto the road direction
 * rather than using the full 2-D gradient magnitude.
 *
 * The "known bug" tests below EXPECT the river-bank slopes to be low; they
 * will fail on the current build and turn green once the bug is fixed.
 */
import { test, expect } from '@playwright/test';
import { gotoLocation, getSlopeAt, ACTION_TIMEOUT } from './map-helpers';

// ---------------------------------------------------------------------------
// Well-known Paris locations
// ---------------------------------------------------------------------------
const PARIS = {
  // BUG – Seine right bank (embankment wall creates false high slope)
  seineRightBankNotreDame: {
    lat: 48.8519, lng: 2.3551, zoom: 16,
    label: 'Seine right bank – Quai de la Tournelle (near Notre-Dame)',
  },
  // BUG – Seine left bank (same problem)
  seineLeftBankEiffel: {
    lat: 48.8598, lng: 2.2966, zoom: 16,
    label: 'Seine left bank – Quai Branly (near Eiffel Tower)',
  },
  // Genuinely steep: Rue Lepic in Montmartre (~12 % grade)
  rueLepic: {
    lat: 48.8851, lng: 2.3338, zoom: 17,
    label: 'Rue Lepic, Montmartre (genuinely steep ~12 %)',
  },
  // Genuinely steep: Rue Foyatier / ramp to Sacré-Cœur
  rueFoyatier: {
    lat: 48.8865, lng: 2.3412, zoom: 17,
    label: 'Rue Foyatier, Montmartre (steep ramp)',
  },
  // Flat: Champs-Élysées (long avenue, nearly level)
  champsElysees: {
    lat: 48.8698, lng: 2.3079, zoom: 16,
    label: 'Avenue des Champs-Élysées (flat)',
  },
  // Flat: Boulevard Haussmann (designed level for traffic)
  boulevardHaussmann: {
    lat: 48.8758, lng: 2.3380, zoom: 16,
    label: 'Boulevard Haussmann (flat)',
  },
} as const;

// ---------------------------------------------------------------------------
// Smoke tests
// ---------------------------------------------------------------------------
test.describe('smoke', () => {
  test('page loads without JS exceptions', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/', { timeout: ACTION_TIMEOUT });
    await expect(page).not.toHaveTitle(/error/i);

    // Filter out expected network noise (tile 404s, etc.)
    const hard = errors.filter(
      (e) => !e.includes('Failed to fetch') && !e.includes('NetworkError'),
    );
    expect(hard).toHaveLength(0);
  });

  test('map canvas is visible', async ({ page }) => {
    await page.goto('/', { timeout: ACTION_TIMEOUT });

    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible({ timeout: ACTION_TIMEOUT });

    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(400);
    expect(box!.height).toBeGreaterThan(300);
  });

  test('testing hooks are present', async ({ page }) => {
    await page.goto('/', { timeout: ACTION_TIMEOUT });

    const hooks = await page.evaluate(() => ({
      hasSlopeMap: typeof (window as any).__slopeMap?.getCenter === 'function',
      hasGetSlopeAt: typeof (window as any).getSlopeAt === 'function',
    }));

    expect(hooks.hasSlopeMap).toBe(true);
    expect(hooks.hasGetSlopeAt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Navigation: localStorage injection centres the map correctly
// ---------------------------------------------------------------------------
test.describe('navigation via localStorage', () => {
  test('map starts at the injected location', async ({ page }) => {
    await gotoLocation(page, 48.8566, 2.3522, 13);

    const center = await page.evaluate(() => {
      const m = (window as any).__slopeMap;
      const c = m.getCenter();
      return { lat: c.lat, lng: c.lng, zoom: m.getZoom() };
    });

    expect(Math.abs(center.lat - 48.8566)).toBeLessThan(0.05);
    expect(Math.abs(center.lng - 2.3522)).toBeLessThan(0.05);
    expect(Math.abs(center.zoom - 13)).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Flat streets: should show low % grade
// ---------------------------------------------------------------------------
test.describe('flat streets have low slopes', () => {
  for (const [key, loc] of Object.entries({
    champsElysees: PARIS.champsElysees,
    boulevardHaussmann: PARIS.boulevardHaussmann,
  })) {
    test(loc.label, async ({ page }) => {
      await gotoLocation(page, loc.lat, loc.lng, loc.zoom);
      const { slope, bufferReady } = await getSlopeAt(page, loc.lat, loc.lng);

      console.log(`[${key}] slope=${slope?.toFixed(2)} % | bufferReady=${bufferReady}`);

      expect(bufferReady).toBe(true);

      if (slope === null) {
        // Coordinate fell outside the buffered area — widen the viewport zoom.
        // This is a test-setup issue, not a slope-value issue.
        throw new Error(`getSlopeAt returned null for ${key} — coordinate outside slope buffer`);
      }

      // Flat avenues should be well under 5 % grade
      expect(slope).toBeLessThan(5);
    });
  }
});

// ---------------------------------------------------------------------------
// Steep streets: Montmartre should register significant slope
// ---------------------------------------------------------------------------
test.describe('steep Montmartre streets have high slopes', () => {
  for (const [key, loc] of Object.entries({
    rueLepic: PARIS.rueLepic,
    rueFoyatier: PARIS.rueFoyatier,
  })) {
    test(loc.label, async ({ page }) => {
      await gotoLocation(page, loc.lat, loc.lng, loc.zoom);
      const { slope, bufferReady } = await getSlopeAt(page, loc.lat, loc.lng);

      console.log(`[${key}] slope=${slope?.toFixed(2)} % | bufferReady=${bufferReady}`);

      expect(bufferReady).toBe(true);

      if (slope === null) {
        throw new Error(`getSlopeAt returned null for ${key} — coordinate outside slope buffer`);
      }

      // Montmartre streets are genuinely above 5 % grade
      expect(slope).toBeGreaterThan(5);
    });
  }
});

// ---------------------------------------------------------------------------
// BUG REGRESSION: Seine river banks must NOT show as high-slope streets
//
// The bug: the road raster includes quai roads whose pixels happen to sit on
// top of the steep embankment wall.  The 2-D gradient magnitude picks up the
// perpendicular drop to the river, producing artificially high % grades.
//
// Expected behaviour after fix: slope < 5 % (the road itself is nearly flat).
// Current behaviour (unfixed): slope may be 15-40 % or more.
//
// These tests WILL FAIL on the current build.  They are intentionally left
// as failing tests to document the bug and serve as a green signal when fixed.
// ---------------------------------------------------------------------------
test.describe('seine river banks – should NOT show as high slope [known bug]', () => {
  for (const [key, loc] of Object.entries({
    seineRightBankNotreDame: PARIS.seineRightBankNotreDame,
    seineLeftBankEiffel: PARIS.seineLeftBankEiffel,
  })) {
    test(loc.label, async ({ page }) => {
      await gotoLocation(page, loc.lat, loc.lng, loc.zoom);
      const { slope, bufferReady } = await getSlopeAt(page, loc.lat, loc.lng);

      console.log(`[${key}] slope=${slope?.toFixed(2)} % | bufferReady=${bufferReady}`);
      console.log(`  NOTE: values above ~5 % indicate the embankment-wall bug is present`);

      expect(bufferReady).toBe(true);

      if (slope === null) {
        throw new Error(`getSlopeAt returned null for ${key} — coordinate outside slope buffer`);
      }

      // After the fix, river-bank roads should read < 5 % (they're nearly flat).
      // This assertion fails today because the perpendicular embankment
      // gradient bleeds into the road pixels.
      expect(slope).toBeLessThan(5);
    });
  }
});

// ---------------------------------------------------------------------------
// Visual snapshot: Paris overview for full-render regression
// ---------------------------------------------------------------------------
test('paris overview visual snapshot', async ({ page }) => {
  await gotoLocation(page, 48.8566, 2.3522, 13);

  // Let slow tiles finish painting
  await page.waitForTimeout(2000);

  await expect(page).toHaveScreenshot('paris-overview.png', {
    maxDiffPixelRatio: 0.03,
    timeout: ACTION_TIMEOUT,
  });
});
