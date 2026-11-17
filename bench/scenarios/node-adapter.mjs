// Headless BenchChart adapter over a stub-backend scene (the node counterpart of browser/driver.ts).
// Headless scrolling is a no-op, so pan() and wheel() provoke a Render frame by other means.
import { SCENES } from '../scenes.mjs';

function snapFrame(stats) {
  return {
    level: stats.level,
    drawCommands: stats.drawCommands,
    displayLists: stats.displayLists,
    sourcesReEmitted: stats.sourcesReEmitted,
    sourcesCached: stats.sourcesCached,
    sourcesUpdated: stats.sourcesUpdated,
    cachedListIdentityViolations: stats.cachedListIdentityViolations,
    timelineRebuilds: stats.timelineRebuilds,
    chunkRecomputes: stats.chunkRecomputes,
    bufferReallocs: stats.bufferReallocs,
    inputLagFrames: stats.inputLagFrames,
    replayMs: stats.replayMs,
  };
}

export function makeNodeBenchChart(fixture) {
  const { chart, raf, series, scene } = fixture;
  const frameSnaps = []; // one per actually painted frame
  let now = 1000;
  let overlayLevel; // the UpdateLevel of an Overlay frame, learned at runtime

  // An idle turn records nothing: the coalescing check counts only actually painted frames.
  const flush = () => {
    const before = fixture.frames.length;
    if (!raf.hasPending()) return false;
    raf.flush(now++);
    if (fixture.frames.length > before) {
      frameSnaps.push(snapFrame(fixture.frames[fixture.frames.length - 1]));
      return true;
    }
    return false;
  };

  const someSeries = series && series.length > 0 ? series[0] : null;
  const lastTime = () => {
    if (someSeries === null) return 0;
    const d = someSeries.data();
    const last = d.length > 0 ? d[d.length - 1] : null;
    return last && typeof last.time === 'number' ? last.time : 0;
  };

  const benchChart = {
    setData(i, data) {
      const s = series && series[i];
      if (s) s.setData(data);
    },
    update(i, point) {
      const s = series && series[i];
      if (s) s.update(point);
    },
    async crosshairMove(x, _y) {
      // Land on a real bar time so the crosshair source has geometry.
      const t = (lastTime() - (Math.round(x) % 64) + 64) % Math.max(1, lastTime() || 1);
      const before = frameSnaps.length;
      chart.setCrosshairPosition(null, t, someSeries ?? undefined);
      const painted = flush();
      // Crosshair is the only Overlay-invalidating call, so its first painted frame reveals that level.
      if (painted && overlayLevel === undefined && frameSnaps.length > before) {
        overlayLevel = frameSnaps[frameSnaps.length - 1].level;
      }
    },
    async wheel(_x, _y, _deltaY) {
      // Render-frame proxy: fitContent invalidates at Render level.
      chart.timeScale().fitContent();
      flush();
    },
    async pan(_dxBars) {
      // Render-frame proxy: a same-time update dirties series 0 without a timeline rebuild.
      if (someSeries !== null) {
        const t = lastTime();
        const d = someSeries.data();
        const last = d.length > 0 ? d[d.length - 1] : null;
        const v = last && typeof last.value === 'number' ? last.value : 100;
        someSeries.update({ time: t, value: v });
      }
      flush();
    },
    async frame() {
      flush();
    },
  };

  return {
    chart: benchChart,
    fixture,
    frameSnaps,
    scene,
    realChart: chart, // the S2b harness attaches its listener here
    // Empty until a crosshairMove has painted a frame.
    overlayFrames: () => (overlayLevel === undefined ? [] : frameSnaps.filter((s) => s.level === overlayLevel)),
  };
}

export async function buildScene(sceneId) {
  const builder = SCENES[sceneId];
  if (builder === undefined) throw new Error(`unknown scene ${sceneId}`);
  return builder();
}
