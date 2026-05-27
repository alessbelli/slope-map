import { Page } from '@playwright/test';

// Key that the app uses to persist map position across sessions.
const VIEW_STORAGE_KEY = 'slope-map-view-v1';

// Hard timeout (ms) applied to individual browser waits.
// Keeps tests from silently hanging when tiles are slow or the site is down.
export const ACTION_TIMEOUT = 20_000;

export interface SlopeResult {
  /** Computed % grade at the coordinate, or null if outside the buffered area. */
  slope: number | null;
  /** Whether the slope buffer has been rendered at all yet. */
  bufferReady: boolean;
}

/**
 * Navigate to a lat/lng/zoom by injecting the saved-view into localStorage
 * BEFORE the page loads, so the app starts centred on the desired location.
 *
 * Call this as a `beforeEach` / `beforeAll` setup, then call `page.goto('/')`.
 */
export async function setInitialView(
  page: Page,
  lat: number,
  lng: number,
  zoom: number,
): Promise<void> {
  await page.addInitScript(
    ({ key, view }) => localStorage.setItem(key, JSON.stringify(view)),
    { key: VIEW_STORAGE_KEY, view: { lat, lng, zoom } },
  );
}

/**
 * Wait for the MapLibre map to finish loading its style.
 * Timeout: ACTION_TIMEOUT ms.
 */
export async function waitForMapLoad(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const m = (window as any).__slopeMap;
      return m != null && m.loaded && m.loaded();
    },
    { timeout: ACTION_TIMEOUT, polling: 300 },
  );
}

/**
 * Wait for the slope raster to finish rendering (tiles loaded + colorized).
 * Timeout: ACTION_TIMEOUT ms.
 */
export async function waitForSlopeRender(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as any).__slopeReady === 'number',
    { timeout: ACTION_TIMEOUT, polling: 300 },
  );
}

/**
 * Full page setup: set localStorage view, navigate, wait for map + slope.
 */
export async function gotoLocation(
  page: Page,
  lat: number,
  lng: number,
  zoom: number,
): Promise<void> {
  await setInitialView(page, lat, lng, zoom);
  await page.goto('/', { timeout: ACTION_TIMEOUT });
  await waitForMapLoad(page);
  await waitForSlopeRender(page);
}

/**
 * Query the slope (% grade) at a geographic coordinate using the app's own
 * `window.getSlopeAt()` testing hook (injected in index.html).
 */
export async function getSlopeAt(
  page: Page,
  lat: number,
  lng: number,
): Promise<SlopeResult> {
  return page.evaluate(
    ([lat, lng]) => {
      const bufferReady = typeof (window as any).__slopeReady === 'number';
      const getSlopeAt = (window as any).getSlopeAt;
      if (!getSlopeAt) return { slope: null, bufferReady };
      const slope = getSlopeAt(lat, lng);
      return { slope: slope ?? null, bufferReady };
    },
    [lat, lng] as [number, number],
  );
}

/**
 * Sample the RGB pixel colour on the MapLibre canvas at the screen position
 * corresponding to [lat, lng].  Useful as a fallback when the slope buffer
 * doesn't cover the requested coordinate.
 *
 * NOTE: MapLibre uses WebGL without `preserveDrawingBuffer`, so pixel reads
 * only work synchronously in the same JS task as the last paint.  This is
 * unreliable in headless environments; prefer `getSlopeAt` instead.
 */
export async function getPixelColorAt(
  page: Page,
  lat: number,
  lng: number,
): Promise<{ r: number; g: number; b: number } | null> {
  return page.evaluate(([lat, lng]) => {
    const map = (window as any).__slopeMap;
    if (!map) return null;
    const pt = map.project([lng, lat]);
    const canvas = map.getCanvas() as HTMLCanvasElement;
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return null;
    const px = Math.round(pt.x);
    const py = Math.round(canvas.height - pt.y);
    const buf = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { r: buf[0], g: buf[1], b: buf[2] };
  }, [lat, lng] as [number, number]);
}
