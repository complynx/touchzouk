const state = {
  catalog: { set: [], song: [] },
  current: null,
  category: "set",
  waveform: [],
  repeat: 0,
  playRequested: false,
  startingPlayback: false,
  playIntent: 0,
  seeking: false,
  seekWasPlaying: false,
  waveformRequest: null,
  pendingStart: null,
  rebinned: new Map(),
  hoverWaveformRatio: null,
  originalOrder: { set: null, song: null },
  shuffled: { set: false, song: false },
  lyricLines: [],
};

const audio = document.querySelector("[data-atlas-audio]");
const playerIdle = document.querySelector("[data-player-idle]");
const playerLoaded = document.querySelector("[data-player-loaded]");
const mainPlay = document.querySelector("[data-main-play]");
const seek = document.querySelector("[data-seek]");
const canvas = document.querySelector("[data-player-waveform]");
const context = canvas.getContext("2d");
const repeatButton = document.querySelector("[data-repeat]");
const shuffleButton = document.querySelector("[data-random]");
const shareButton = document.querySelector("[data-share]");
const shareStatus = document.querySelector("[data-share-status]");
const volumePickers = [...document.querySelectorAll("[data-volume]")];
const menuButton = document.querySelector(".menu-toggle");
const menu = document.querySelector(".site-nav");
const menuLabel = menuButton.querySelector(".sr-only");
const catalogTabs = document.querySelector("[data-catalog-tabs]");
const catalogStatus = document.querySelector("[data-catalog-status]");
const waveCanvas = document.querySelector(".wave-canvas");
const playerCues = document.querySelector("[data-player-cues]");
const playerText = document.querySelector("[data-player-text]");
const textPrevious = document.querySelector("[data-text-previous]");
const textCurrent = document.querySelector("[data-text-current]");
const textNext = document.querySelector("[data-text-next]");
const textDialog = document.querySelector("[data-text-dialog]");
const textDialogTitle = document.querySelector("[data-text-dialog-title]");
const textDialogBody = document.querySelector("[data-text-dialog-body]");
const copyLyrics = document.querySelector("[data-copy-lyrics]");
const copyLyricsStatus = document.querySelector("[data-copy-lyrics-status]");
const copyLyricsIcon = copyLyrics.querySelector("[data-copy-icon]");
const copyLyricsSuccess = copyLyrics.querySelector("[data-copy-success]");
const skyCanvas = document.querySelector("[data-atlas-sky]");
const fallbackWaveform = Array.from({ length: 180 }, (_, index) => .2 + Math.abs(Math.sin(index * .47) * Math.cos(index * .09) * .65));
const playbackRequest = TouchzoukUI.playbackRequest();
let waveformFrame = 0;
let playerTextFrame = 0;

function startAtlasSky() {
  const scene = document.querySelector(".atlas-main");
  const sky = skyCanvas.getContext("2d");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let stars = [];
  let orbs = [];
  let bodies = [];
  let edges = [];
  let pointer = { clientX: 0, clientY: 0, active: false };
  let frame = 0;
  let drawTimer = 0;
  let width = 1;
  let height = 1;
  let scrollOrigin = window.scrollY;
  let shootingStar = null;
  let nextShootingAt = 0;
  let blinkingStar = null;
  let nextBlinkAt = 0;
  const sceneSeed = Math.random() * 10000;

  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const between = (value, left, right) => value >= Math.min(left, right) && value <= Math.max(left, right);
  const onSegment = (a, b, point) => Math.abs(cross(a, b, point)) < .001
    && between(point.x, a.x, b.x) && between(point.y, a.y, b.y);
  const intersects = (edgeA, edgeB) => {
    const sourceA = [edgeA.sourceA || edgeA.a, edgeA.sourceB || edgeA.b];
    const sourceB = [edgeB.sourceA || edgeB.a, edgeB.sourceB || edgeB.b];
    if (sourceA.some((star) => sourceB.includes(star))) return false;
    const abA = cross(edgeA.a, edgeA.b, edgeB.a);
    const abB = cross(edgeA.a, edgeA.b, edgeB.b);
    const cdA = cross(edgeB.a, edgeB.b, edgeA.a);
    const cdB = cross(edgeB.a, edgeB.b, edgeA.b);
    if ((abA > 0) !== (abB > 0) && (cdA > 0) !== (cdB > 0)) return true;
    return onSegment(edgeA.a, edgeA.b, edgeB.a) || onSegment(edgeA.a, edgeA.b, edgeB.b)
      || onSegment(edgeB.a, edgeB.b, edgeA.a) || onSegment(edgeB.a, edgeB.b, edgeA.b);
  };
  const distanceToSegment = (point, a, b) => {
    const lengthSquared = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    if (!lengthSquared) return Math.hypot(point.x - a.x, point.y - a.y);
    const ratio = Math.max(0, Math.min(1, ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / lengthSquared));
    return Math.hypot(point.x - (a.x + ratio * (b.x - a.x)), point.y - (a.y + ratio * (b.y - a.y)));
  };
  const starDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const evenlySpacedEllipseAngles = (squash, pointCount) => {
    const sampleCount = pointCount * 8;
    const cumulative = [0];
    let previous = { x: 1, y: 0 };
    for (let sample = 1; sample <= sampleCount; sample += 1) {
      const angle = sample * Math.PI * 2 / sampleCount;
      const point = { x: Math.cos(angle), y: Math.sin(angle) * squash };
      cumulative.push(cumulative[sample - 1] + starDistance(previous, point));
      previous = point;
    }
    const total = cumulative[sampleCount];
    let sample = 1;
    const angles = Array.from({ length: pointCount + 1 }, (_, index) => {
      const target = total * index / pointCount;
      while (sample < sampleCount && cumulative[sample] < target) sample += 1;
      const segmentLength = cumulative[sample] - cumulative[sample - 1];
      const ratio = segmentLength ? (target - cumulative[sample - 1]) / segmentLength : 0;
      return (sample - 1 + ratio) * Math.PI * 2 / sampleCount;
    });
    angles[pointCount / 4] = Math.PI / 2;
    angles[pointCount / 2] = Math.PI;
    angles[pointCount * 3 / 4] = Math.PI * 1.5;
    angles[pointCount] = Math.PI * 2;
    return angles;
  };
  const schwarzschildCriticalImpact = 3 * Math.sqrt(3) / 2;
  const schwarzschildAngleIntegral = (inverseImpactSquared, inverseRadiusLimit) => {
    // This substitution removes the square-root singularity at a ray's turning point.
    const steps = 96;
    let sum = 0;
    for (let step = 0; step < steps; step += 1) {
      const parameter = (step + .5) / steps;
      const inverseRadius = inverseRadiusLimit * (2 * parameter - parameter ** 2);
      const derivative = 2 * inverseRadiusLimit * (1 - parameter);
      const radialSpeedSquared = inverseImpactSquared
        - inverseRadius ** 2 * (1 - inverseRadius);
      sum += derivative / Math.sqrt(Math.max(Number.EPSILON, radialSpeedSquared));
    }
    return sum / steps;
  };
  const schwarzschildTurningInverseRadius = (inverseImpactSquared) => {
    const criticalEnergy = 4 / 27;
    return 1 / 3 + 2 / 3 * Math.sin(Math.asin(2 * inverseImpactSquared / criticalEnergy - 1) / 3);
  };
  const schwarzschildImpactForSweep = (sourceRadius, sweep) => {
    const inverseSourceRadius = 1 / sourceRadius;
    const maximumImpact = sourceRadius / Math.sqrt(1 - inverseSourceRadius);
    const tangentEnergy = 1 / maximumImpact ** 2;
    const tangentSweep = schwarzschildAngleIntegral(tangentEnergy, inverseSourceRadius);
    const outbound = sweep > tangentSweep;
    let lowerImpact = outbound ? schwarzschildCriticalImpact * (1 + 1e-7) : 0;
    let upperImpact = maximumImpact;
    const angleAtImpact = (impact) => {
      if (!impact) return 0;
      const inverseImpactSquared = 1 / impact ** 2;
      const inboundSweep = schwarzschildAngleIntegral(inverseImpactSquared, inverseSourceRadius);
      if (!outbound) return inboundSweep;
      const turningInverseRadius = schwarzschildTurningInverseRadius(inverseImpactSquared);
      return 2 * schwarzschildAngleIntegral(inverseImpactSquared, turningInverseRadius) - inboundSweep;
    };
    for (let iteration = 0; iteration < 28; iteration += 1) {
      const impact = (lowerImpact + upperImpact) / 2;
      const candidateSweep = angleAtImpact(impact);
      if (outbound ? candidateSweep > sweep : candidateSweep < sweep) lowerImpact = impact;
      else upperImpact = impact;
    }
    return {
      impact: (lowerImpact + upperImpact) / 2,
      foreground: !outbound,
    };
  };
  const traceSchwarzschildRing = (sourceRadius, inclinationCosine, angles, family, order = 0) => {
    const inclinationSine = Math.sqrt(1 - inclinationCosine ** 2);
    const points = angles.map((angle) => {
      const sourceX = Math.cos(angle);
      const sourceY = Math.sin(angle) * inclinationCosine;
      const sourceDepth = Math.sin(angle) * inclinationSine;
      const projectedRadius = Math.hypot(sourceX, sourceY);
      const sourceSeparation = Math.atan2(projectedRadius, sourceDepth);
      const sameSide = family === "direct";
      const sweep = (sameSide ? sourceSeparation : Math.PI * 2 - sourceSeparation)
        + order * Math.PI * 2;
      const ray = schwarzschildImpactForSweep(sourceRadius, sweep);
      const side = sameSide ? 1 : -1;
      return {
        x: side * ray.impact * sourceX / projectedRadius,
        y: side * ray.impact * sourceY / projectedRadius,
        foreground: ray.foreground,
      };
    });
    points[points.length - 1] = { ...points[0] };
    return points;
  };
  const pointInPath = (point, path) => {
    let inside = false;
    for (let index = 0, previous = path.length - 2; index < path.length - 1; previous = index, index += 1) {
      const a = path[index];
      const b = path[previous];
      if ((a.y > point.y) !== (b.y > point.y)
        && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
  const segmentIntersectionRatio = (a, b, c, d) => {
    const abX = b.x - a.x;
    const abY = b.y - a.y;
    const cdX = d.x - c.x;
    const cdY = d.y - c.y;
    const denominator = abX * cdY - abY * cdX;
    if (Math.abs(denominator) < 1e-9) return null;
    const acX = c.x - a.x;
    const acY = c.y - a.y;
    const sourceRatio = (acX * cdY - acY * cdX) / denominator;
    const boundaryRatio = (acX * abY - acY * abX) / denominator;
    return sourceRatio > 1e-7 && sourceRatio < 1 - 1e-7
      && boundaryRatio >= 0 && boundaryRatio <= 1 ? sourceRatio : null;
  };
  const clipPathOutsideAnnulus = (path, outerBoundary, innerBoundary) => {
    const boundaries = [outerBoundary, innerBoundary];
    const runs = [];
    let currentRun = null;
    for (let index = 0; index < path.length - 1; index += 1) {
      const source = path[index];
      const target = path[index + 1];
      const ratios = [0, 1];
      boundaries.forEach((boundary) => {
        for (let boundaryIndex = 0; boundaryIndex < boundary.length - 1; boundaryIndex += 1) {
          const ratio = segmentIntersectionRatio(
            source, target, boundary[boundaryIndex], boundary[boundaryIndex + 1],
          );
          if (ratio !== null) ratios.push(ratio);
        }
      });
      ratios.sort((a, b) => a - b);
      const uniqueRatios = ratios.filter((ratio, ratioIndex) => (
        !ratioIndex || ratio - ratios[ratioIndex - 1] > 1e-6
      ));
      for (let ratioIndex = 0; ratioIndex < uniqueRatios.length - 1; ratioIndex += 1) {
        const startRatio = uniqueRatios[ratioIndex];
        const endRatio = uniqueRatios[ratioIndex + 1];
        const pointAt = (ratio) => ({
          x: source.x + (target.x - source.x) * ratio,
          y: source.y + (target.y - source.y) * ratio,
        });
        const midpoint = pointAt((startRatio + endRatio) / 2);
        const occluded = pointInPath(midpoint, outerBoundary)
          && !pointInPath(midpoint, innerBoundary);
        if (occluded) {
          currentRun = null;
          continue;
        }
        const start = pointAt(startRatio);
        const end = pointAt(endRatio);
        if (!currentRun) {
          currentRun = [start, end];
          runs.push(currentRun);
        } else {
          currentRun.push(end);
        }
      }
    }
    if (runs.length > 1) {
      const first = runs[0];
      const last = runs[runs.length - 1];
      if (starDistance(first[0], last[last.length - 1]) < 1e-6) {
        runs[0] = [...last.slice(0, -1), ...first];
        runs.pop();
      }
    }
    return runs;
  };
  const constellationEdge = (a, b) => ({ a, b, distance: starDistance(a, b) });
  // Euclidean MST gives a non-crossing base with incident angles >=60deg; loops keep an explicit 30deg floor.
  const minimumSpanningTree = (cluster) => {
    const connected = new Set(cluster.slice(0, 1));
    const remaining = new Set(cluster.slice(1));
    const tree = [];
    while (remaining.size) {
      let shortest = null;
      connected.forEach((a) => remaining.forEach((b) => {
        const candidate = constellationEdge(a, b);
        if (!shortest || candidate.distance < shortest.distance) shortest = candidate;
      }));
      tree.push(shortest);
      connected.add(shortest.b);
      remaining.delete(shortest.b);
    }
    return tree;
  };
  const incidentAngle = (origin, left, right) => {
    const leftVector = { x: left.x - origin.x, y: left.y - origin.y };
    const rightVector = { x: right.x - origin.x, y: right.y - origin.y };
    const cosine = (leftVector.x * rightVector.x + leftVector.y * rightVector.y)
      / (Math.hypot(leftVector.x, leftVector.y) * Math.hypot(rightVector.x, rightVector.y));
    return Math.acos(Math.max(-1, Math.min(1, cosine)));
  };
  const acceptsEdgeAngles = (candidate, graph) => [candidate.a, candidate.b].every((star) => {
    const other = star === candidate.a ? candidate.b : candidate.a;
    return graph
      .filter((edge) => edge.a === star || edge.b === star)
      .every((edge) => incidentAngle(star, other, edge.a === star ? edge.b : edge.a) >= 30 * Math.PI / 180);
  });
  const spreadCluster = (seed, pool, targetSize) => {
    const cluster = [seed];
    while (cluster.length < targetSize) {
      const next = pool
        .filter((star) => !cluster.includes(star))
        .map((star) => ({ star, spread: Math.min(...cluster.map((selected) => starDistance(star, selected))) }))
        .sort((a, b) => b.spread - a.spread)[0]?.star;
      if (!next) break;
      cluster.push(next);
    }
    return cluster;
  };
  const scheduleShootingStar = (now) => {
    const normal = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(Math.PI * 2 * Math.random());
    const delay = Math.max(35000, Math.min(140000, 80000 + normal * 18000));
    nextShootingAt = now + delay;
  };
  const scheduleBlink = (now) => {
    nextBlinkAt = now + 1200 + Math.pow(Math.random(), 1.6) * 4700;
  };
  const launchBlink = (now) => {
    const weighted = stars.map((star) => ({ star, weight: 1 / Math.pow(star.radius + .25, 1.8) }));
    const total = weighted.reduce((sum, candidate) => sum + candidate.weight, 0);
    let pick = Math.random() * total;
    const selected = weighted.find((candidate) => ((pick -= candidate.weight) <= 0))?.star || stars[0];
    if (!selected) return;
    const power = .12 + Math.pow(Math.random(), 3.8) * .88;
    blinkingStar = { star: selected, start: now, power, duration: 260 + power * 500 + Math.random() * 140 };
    scheduleBlink(now);
  };
  const launchShootingStar = (now) => {
    const angle = Math.PI * (.16 + Math.random() * .68);
    const length = Math.min(300, Math.max(140, width * .24)) * (.8 + Math.random() * .4);
    const dx = Math.cos(angle) * length;
    const dy = Math.sin(angle) * length;
    const minX = Math.max(0, -dx);
    const maxX = Math.max(minX, width - Math.max(0, dx));
    shootingStar = {
      start: now,
      duration: 850 + Math.random() * 550,
      x: minX + Math.random() * (maxX - minX),
      y: Math.random() * Math.max(1, height - dy),
      dx,
      dy,
    };
    scheduleShootingStar(now);
  };

  function generate() {
    width = Math.max(1, window.innerWidth);
    height = Math.max(1, window.innerHeight);
    const ratio = Math.min(1.5, window.devicePixelRatio || 1);
    skyCanvas.width = Math.floor(width * ratio);
    skyCanvas.height = Math.floor(height * ratio);
    sky.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (!nextShootingAt) scheduleShootingStar(performance.now());
    blinkingStar = null;
    scheduleBlink(performance.now());
    const random = (seed) => {
      let value = (Math.floor(seed * 1009) + Math.floor(sceneSeed) + Math.floor(width * 31 + height * 17)) >>> 0;
      value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
      value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
      return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
    };
    const area = width * height;
    const anchorCount = Math.max(36, Math.min(120, Math.floor(area / 16000)));
    const faintCount = Math.max(60, Math.min(420, Math.floor(area / 4200)));
    const anchorSpacing = Math.max(20, Math.min(35, Math.min(width, height) * .035));
    const anchorStars = [];
    for (let attempt = 0; anchorStars.length < anchorCount && attempt < anchorCount * 20; attempt += 1) {
      const brightness = Math.pow(random(attempt * 7 + 3), 4);
      const star = {
        x: 12 + random(attempt * 7 + 1) * (width - 24),
        y: 9 + random(attempt * 7 + 2) * (height - 18),
        radius: .55 + brightness * 1.85,
        opacity: .38 + brightness * .48,
        spacing: anchorSpacing * (.52 + brightness * .48),
        bright: true,
        spiked: random(attempt * 7 + 4) < .14,
        parallax: .006 + random(attempt + 37) * .009,
        driftRadius: 0,
        driftRank: random(attempt + 47),
        driftPhase: random(attempt + 67) * Math.PI * 2,
        driftRate: .000055 + random(attempt + 77) * .000055,
        pullStrength: .022,
        attractionX: 0,
        attractionY: 0,
        glow: 0,
      };
      if (anchorStars.every((other) => starDistance(star, other) > Math.min(star.spacing, other.spacing))) anchorStars.push(star);
    }
    const faintStars = [];
    for (let attempt = 0; faintStars.length < faintCount && attempt < faintCount * 8; attempt += 1) {
      const brightness = Math.pow(random(5000 + attempt * 7 + 3), 4);
      const star = {
        x: 5 + random(5000 + attempt * 7 + 1) * (width - 10),
        y: 4 + random(5000 + attempt * 7 + 2) * (height - 8),
        radius: .18 + brightness * .68,
        opacity: .1 + brightness * .28,
        bright: false,
        spiked: false,
        parallax: .003 + random(5037 + attempt) * .008,
        driftRadius: 0,
        driftRank: random(5047 + attempt),
        driftPhase: random(5067 + attempt) * Math.PI * 2,
        driftRate: .00004 + random(5077 + attempt) * .00005,
        pullStrength: .012,
        attractionX: 0,
        attractionY: 0,
        glow: 0,
      };
      if (anchorStars.every((other) => starDistance(star, other) > 7)
        && faintStars.every((other) => starDistance(star, other) > 3.5)) faintStars.push(star);
    }
    stars = [...faintStars, ...anchorStars];
    const constellationCellSize = Math.max(90, Math.min(150, Math.min(width, height) * .15));
    const constellationColumns = Math.ceil(width / constellationCellSize);
    const constellationRows = Math.ceil(height / constellationCellSize);
    const constellationStars = new Set();
    for (let row = 0; row < constellationRows; row += 1) {
      for (let column = 0; column < constellationColumns; column += 1) {
        stars
          .filter((star) => star.x >= column * constellationCellSize && star.x < (column + 1) * constellationCellSize
            && star.y >= row * constellationCellSize && star.y < (row + 1) * constellationCellSize)
          .sort((a, b) => b.radius - a.radius || b.opacity - a.opacity)
          .slice(0, 2)
          .forEach((star) => constellationStars.add(star));
      }
    }
    const remaining = new Set(constellationStars);
    const coverageColumns = width < 420 ? 1 : Math.min(6, Math.max(2, Math.ceil(width / 360)));
    const coverageRows = width < 600
      ? Math.min(4, Math.max(1, Math.ceil(height / 210)))
      : Math.min(4, Math.max(1, Math.ceil(height / 280)));
    const maxClusters = coverageColumns * coverageRows;
    const seedOrder = [...constellationStars]
      .map((star, index) => ({ star, rank: random(9000 + index) }))
      .sort((a, b) => a.rank - b.rank)
      .map(({ star }) => star);
    const coverageRegions = Array.from({ length: maxClusters }, (_, index) => {
      const column = index % coverageColumns;
      const row = Math.floor(index / coverageColumns);
      return {
        x: [column / coverageColumns, (column + 1) / coverageColumns],
        y: [row / coverageRows, (row + 1) / coverageRows],
      };
    });
    const inRegion = (star, region) => star.x >= region.x[0] * width && star.x <= region.x[1] * width
      && star.y >= region.y[0] * height && star.y <= region.y[1] * height;
    edges = [];
    const connectedClusters = [];
    const edgeIsDrawable = (edge) => edge.distance > Math.max(edge.a.radius, .5) + Math.max(edge.b.radius, .5) + 8;
    const edgeAvoidsStars = (edge, cluster) => {
      const visibleStars = new Set([
        ...anchorStars.filter((star) => star.bright),
        ...connectedClusters.flat(),
        ...cluster,
      ]);
      return [...visibleStars].every((star) => star === edge.a || star === edge.b
        || distanceToSegment(star, edge.a, edge.b) >= 7);
    };
    const treeIsClear = (tree, cluster) => tree.every((candidate) => edgeIsDrawable(candidate)
      && !edges.some((edge) => intersects(candidate, edge))
      && edgeAvoidsStars(candidate, cluster));
    const tryConstellation = (seed, clusterIndex, radiusScale, region) => {
      if (connectedClusters.length >= maxClusters || !remaining.has(seed)) return false;
      const searchRadius = Math.max(88, Math.min(width, height) * (.12 + random(9100 + clusterIndex) * .06)) * radiusScale;
      const targetSize = 6 + Math.floor(random(9200 + clusterIndex) * (width < 600 ? 3 : 5));
      const pool = [...remaining].filter((star) => star !== seed && inRegion(star, region)
        && starDistance(seed, star) <= searchRadius);
      const cluster = spreadCluster(seed, pool, targetSize);
      if (cluster.length < 6) return false;
      const span = Math.max(...cluster.flatMap((a) => cluster.map((b) => starDistance(a, b))));
      if (span < Math.max(65, Math.min(width, height) * .12)) return false;
      const tree = minimumSpanningTree(cluster);
      if (!treeIsClear(tree, cluster)) return false;
      const loop = cluster.flatMap((a, index) => cluster.slice(index + 1).map((b) => constellationEdge(a, b)))
        .filter((candidate) => !tree.some((edge) => (edge.a === candidate.a && edge.b === candidate.b)
          || (edge.a === candidate.b && edge.b === candidate.a))
          && candidate.distance < span * .72
          && edgeIsDrawable(candidate)
          && acceptsEdgeAngles(candidate, tree)
          && edgeAvoidsStars(candidate, cluster)
          && !tree.some((edge) => intersects(candidate, edge))
          && !edges.some((edge) => intersects(candidate, edge)))
        .sort((a, b) => Math.abs(a.distance - span * .45) - Math.abs(b.distance - span * .45))[0];
      const constellationEdges = random(9300 + clusterIndex) < .42 && loop ? [...tree, loop] : tree;
      edges.push(...constellationEdges);
      connectedClusters.push(cluster);
      cluster.forEach((star) => remaining.delete(star));
      return true;
    };
    const coveredRegions = new Set();
    for (const radiusScale of [1, 1.35, 1.7]) {
      coverageRegions.forEach((region, regionIndex) => {
        if (coveredRegions.has(regionIndex)) return;
        const center = {
          x: width * (region.x[0] + region.x[1]) / 2,
          y: height * (region.y[0] + region.y[1]) / 2,
        };
        const accepted = seedOrder
          .filter((seed) => remaining.has(seed) && inRegion(seed, region))
          .sort((a, b) => starDistance(a, center) - starDistance(b, center))
          .some((seed) => tryConstellation(seed, seedOrder.indexOf(seed), radiusScale, region));
        if (accepted) coveredRegions.add(regionIndex);
      });
      if (coveredRegions.size >= coverageRegions.length) break;
    }
    coverageRegions.forEach((region, regionIndex) => {
      if (coveredRegions.has(regionIndex)) return;
      const usedStars = new Set(connectedClusters.flat());
      const regionalStars = stars
        .filter((star) => !usedStars.has(star) && inRegion(star, region))
        .sort((a, b) => b.radius - a.radius || b.opacity - a.opacity);
      const fallbackRadius = Math.max(88, Math.min(width, height) * .16);
      let fallback = null;
      regionalStars.some((seed) => {
        const localStars = regionalStars.filter((star) => star !== seed && starDistance(seed, star) <= fallbackRadius);
        for (let targetSize = Math.min(8, localStars.length + 1); targetSize >= 6; targetSize -= 1) {
          const cluster = spreadCluster(seed, localStars, targetSize);
          const tree = minimumSpanningTree(cluster);
          if (!treeIsClear(tree, cluster)) continue;
          fallback = { cluster, tree, synthetic: false };
          return true;
        }
        return false;
      });
      const baseTemplate = [
        [-.85, -.15], [-.5, -.62], [-.15, -.25], [.25, -.55], [.72, -.2], [.48, .38], [-.18, .65],
      ];
      const template = baseTemplate.map(([x, y], index) => [
        x + (random(9700 + regionIndex * 20 + index) - .5) * .08,
        y + (random(9800 + regionIndex * 20 + index) - .5) * .08,
      ]);
      const regionWidth = (region.x[1] - region.x[0]) * width;
      const regionHeight = (region.y[1] - region.y[0]) * height;
      const scale = Math.max(24, Math.min(fallbackRadius * .55, regionWidth * .25, regionHeight * .25));
      const positionOffset = Math.floor(random(9400 + regionIndex) * 9);
      const angleOffset = random(9500 + regionIndex) * Math.PI * 2;
      const mirror = random(9600 + regionIndex) < .5 ? -1 : 1;
      const makeFallbackStar = (x, y) => ({
        x,
        y,
        radius: .55,
        opacity: .4,
        bright: true,
        spiked: false,
        parallax: .01,
        driftRadius: 0,
        driftRank: 1,
        driftPhase: 0,
        driftRate: .00005,
        pullStrength: .022,
        attractionX: 0,
        attractionY: 0,
        glow: 0,
      });
      const templateCluster = (centerX, centerY, angle) => template.map(([x, y]) => {
        const mirroredX = x * mirror;
        return makeFallbackStar(
          centerX + (mirroredX * Math.cos(angle) - y * Math.sin(angle)) * scale,
          centerY + (mirroredX * Math.sin(angle) + y * Math.cos(angle)) * scale,
        );
      });
      const clusterFits = (cluster) => cluster.every((star) => inRegion(star, region));
      const treeHasSafeGeometry = (tree, cluster) => clusterFits(cluster)
        && tree.every((candidate) => edgeIsDrawable(candidate)
          && !edges.some((edge) => intersects(candidate, edge)));
      let forcedFallback = null;
      for (let step = 0; !fallback && step < 9; step += 1) {
        const position = (step + positionOffset) % 9;
        const centerX = width * (region.x[0] + (region.x[1] - region.x[0]) * (.3 + (position % 3) * .2));
        const centerY = height * (region.y[0] + (region.y[1] - region.y[0]) * (.3 + Math.floor(position / 3) * .2));
        for (let turn = 0; !fallback && turn < 4; turn += 1) {
          const cluster = templateCluster(centerX, centerY, angleOffset + turn * Math.PI / 4);
          const tree = minimumSpanningTree(cluster);
          if (!treeHasSafeGeometry(tree, cluster)) continue;
          forcedFallback ||= { cluster, tree, synthetic: true };
          if (treeIsClear(tree, cluster)) fallback = { cluster, tree, synthetic: true };
        }
      }
      if (!fallback && forcedFallback) {
        fallback = forcedFallback;
        anchorStars
          .filter((star) => star.bright && !fallback.cluster.includes(star)
            && fallback.tree.some((edge) => distanceToSegment(star, edge.a, edge.b) < 7))
          .forEach((star) => {
            star.bright = false;
            star.radius = Math.min(star.radius, .45);
            star.opacity = Math.min(star.opacity, .3);
          });
      }
      if (!fallback) return;
      if (fallback.synthetic) fallback.cluster.forEach((star) => {
        stars.push(star);
        anchorStars.push(star);
        constellationStars.add(star);
      });
      edges.push(...fallback.tree);
      connectedClusters.push(fallback.cluster);
      fallback.cluster.forEach((star) => remaining.delete(star));
      coveredRegions.add(regionIndex);
    });
    const connectedStars = new Set(connectedClusters.flat());
    connectedStars.forEach((star) => {
      star.parallax = .01;
      star.radius = Math.max(star.radius, .5);
      star.opacity = Math.max(star.opacity, .4);
      star.bright = true;
    });
    const orbCount = Math.max(5, Math.min(14, Math.floor(height / 260)));
    const decoratedCount = Math.min(orbCount - 1, Math.max(2, Math.ceil(orbCount * .5)));
    const decorated = new Set(Array.from({ length: orbCount }, (_, index) => index)
      .sort((a, b) => random(291 + a) - random(291 + b))
      .slice(0, decoratedCount));
    const orbDesigns = [
      "ringed", "beaded", "crest", "sun", "orbital", "halo", "conjunction", "cratered", "gas-giant", "black-hole",
    ];
    const randomOrbDesigns = orbDesigns.flatMap((design) => (
      Array.from({ length: design === "black-hole" ? 1 : 4 }, () => design)
    ));
    const atlasParameters = new URLSearchParams(window.location.search);
    const requestedPlanet = atlasParameters.get("planets")?.toLowerCase().replaceAll("-", "");
    const requestedDesign = orbDesigns.find((design) => design.replaceAll("-", "") === requestedPlanet);
    const orbExtent = (orb) => {
      if (orb.design === "ringed") return orb.radius * orb.ringScale;
      if (orb.design === "beaded") return orb.radius + 4;
      if (orb.design === "orbital") return orb.radius * orb.orbitScale * (1 + (orb.orbitCount - 1) * .16) + orb.orbitMoonRadius;
      if (orb.design === "halo") return orb.radius * orb.haloScale;
      if (orb.design === "conjunction") return orb.radius * (orb.conjunctionDistance + orb.companionScale);
      if (orb.design === "black-hole") {
        const horizonScale = orb.blackHoleShadowScale / schwarzschildCriticalImpact;
        const sourceRadius = orb.blackHoleScale / horizonScale;
        const maximumImpact = sourceRadius / Math.sqrt(1 - 1 / sourceRadius);
        return orb.radius * horizonScale * maximumImpact + 4;
      }
      return orb.radius;
    };
    orbs = [];
    for (let index = 0; index < orbCount; index += 1) {
      const design = requestedDesign
        || (decorated.has(index)
          ? randomOrbDesigns[Math.floor(random(410 + index) * randomOrbDesigns.length)]
          : "plain");
      const craterTarget = 13 + Math.floor(random(1700 + index) * 7);
      const largeCraterCount = 3 + Math.floor(random(1710 + index) * 3);
      const edgeCraterCount = 1 + Math.floor(random(1790 + index) * 3);
      const craters = [];
      const craterPhase = random(1780 + index) * Math.PI * 2;
      for (let attempt = 0; craters.length < craterTarget && attempt < 180; attempt += 1) {
        const seed = 2000 + index * 1000 + attempt * 4;
        const craterIndex = craters.length;
        const large = craters.length < largeCraterCount;
        const edge = craterIndex >= craterTarget - edgeCraterCount;
        const craterRadius = edge
          ? .06 + random(seed) * .08
          : large
            ? .105 + random(seed) * .09
            : .025 + random(seed) * .065;
        const distance = edge
          ? 1 - craterRadius * (.25 + random(seed + 1) * .45)
          : Math.sqrt(random(seed + 1)) * (.82 - craterRadius);
        const angle = craterPhase + craterIndex * Math.PI * (3 - Math.sqrt(5))
          + (random(seed + 2) - .5) * .45;
        const crater = {
          x: Math.cos(angle) * distance,
          y: Math.sin(angle) * distance,
          radius: craterRadius,
          dot: !large && !edge && (craterIndex - largeCraterCount) % 4 === 0,
        };
        if (craters.every((other) => (
          Math.hypot(crater.x - other.x, crater.y - other.y) > crater.radius + other.radius + .025
        ))) craters.push(crater);
      }
      const gasStyle = random(1720 + index) < .5 ? "contour" : "stripes";
      const gasBandCount = (gasStyle === "contour" ? 5 : 7) + Math.floor(random(1730 + index) * 4);
      const gasGapCount = gasBandCount - 1;
      const orbRadius = design === "black-hole"
        ? 11 + Math.pow(random(340 + index), 3) * 45
        : 15 + random(340 + index) * 34;
      const wideGasGap = Math.floor(gasGapCount / 2);
      const tightGasGap = Math.max(1, wideGasGap - 2);
      const gasBandWeights = Array.from({ length: gasGapCount }, (_, gapIndex) => {
        if (gapIndex === tightGasGap) return .45 + random(2800 + index * 30 + gapIndex) * .1;
        if (gapIndex === wideGasGap) return 3.5 + random(2800 + index * 30 + gapIndex) * .5;
        return .65 + random(2800 + index * 30 + gapIndex) * .25;
      });
      const gasGapWeightTotal = gasBandWeights.reduce((total, gap) => total + gap, 0);
      const minimumGasGap = 1.6;
      const distributableGasSpan = orbRadius * 1.44 - minimumGasGap * gasGapCount;
      const gasBandGaps = gasBandWeights.map((weight) => (
        minimumGasGap + distributableGasSpan * weight / gasGapWeightTotal
      ));
      let gasGapOffset = -orbRadius * .72;
      const gasBandPositions = Array.from({ length: gasBandCount }, (_, bandIndex) => {
        if (bandIndex) gasGapOffset += gasBandGaps[bandIndex - 1];
        return gasGapOffset / orbRadius;
      });
      const ringScale = 1.35 + random(1490 + index) * 1.05;
      const ringMinorScale = .1 + random(1480 + index) * .42;
      const orbitScale = 1.3 + random(1600 + index) * .55;
      const orbitCount = 1 + Math.floor(random(1630 + index) * 2);
      const outerOrbitScale = orbitScale * (1 + (orbitCount - 1) * .16);
      const orbitMinorScale = .1 + random(1610 + index) * .42;
      const blackHoleScale = 1.75 + random(1810 + index) * .5;
      const blackHoleMinorScale = .2 + random(1820 + index) * .14;
      const blackHoleBandCount = 2 + Math.floor(random(1840 + index) * 2);
      const blackHoleBandSpread = .42 + random(1850 + index) * .06;
      const blackHoleSquash = blackHoleMinorScale / blackHoleScale;
      const blackHolePointCount = 96;
      const orb = {
        radius: orbRadius,
        parallax: .01,
        pullStrength: .06,
        warmth: random(380 + index),
        angle: random(400 + index) * Math.PI * 2,
        design,
        ringScale,
        ringAngle: random(1470 + index) * Math.PI * 2,
        ringSquash: ringMinorScale / ringScale,
        orbitScale,
        orbitSquash: orbitMinorScale / outerOrbitScale,
        orbitAngle: random(1620 + index) * Math.PI * 2,
        orbitCount,
        orbitPhase: random(1640 + index) * Math.PI * 2,
        orbitMoonRadius: 1.5 + random(1650 + index) * 2,
        blackHoleScale,
        blackHoleSquash,
        blackHoleShadowScale: .65,
        blackHoleAngle: random(1830 + index) * Math.PI * 2,
        blackHoleAngles: design === "black-hole"
          ? evenlySpacedEllipseAngles(blackHoleSquash, blackHolePointCount)
          : [],
        blackHoleBandScales: Array.from({ length: blackHoleBandCount }, (_, bandIndex) => (
          1 - blackHoleBandSpread * Math.pow(bandIndex / (blackHoleBandCount - 1), .7)
        )),
        haloScale: 1.25 + random(1660 + index) * .5,
        haloCount: 2 + Math.floor(random(1670 + index) * 2),
        haloPhase: random(1680 + index) * Math.PI * 2,
        conjunctionDistance: 1.4 + random(1690 + index) * .55,
        companionScale: .2 + random(1760 + index) * .22,
        conjunctionAngle: random(1770 + index) * Math.PI * 2,
        gasStyle,
        gasBandCount,
        gasBandPositions,
        gasPhase: random(1740 + index) * Math.PI * 2,
        gasFlow: .1 + random(1750 + index) * .1,
        craters,
        beadCount: 1 + Math.floor(random(420 + index) * 3),
        beadStart: random(430 + index) * Math.PI * 2,
        rayCount: 9 + Math.floor(random(440 + index) * 6),
        crestInnerScale: .72 + random(450 + index) * .1,
        crestOffsetScale: .34 + random(460 + index) * .1,
        attractionX: 0,
        attractionY: 0,
        glow: 0,
      };
      const extent = orbExtent(orb);
      const margin = extent + 6;
      const availableWidth = width - margin * 2;
      const availableHeight = height - margin * 2;
      if (availableWidth < 0 || availableHeight < 0) continue;
      const preferOpenSky = random(470 + index) < .8;
      let fallback = null;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const seed = 10000 + index * 300 + attempt * 2;
        const candidate = {
          ...orb,
          x: margin + random(seed) * availableWidth,
          y: margin + random(seed + 1) * availableHeight,
        };
        if (!orbs.every((other) => starDistance(candidate, other) > extent + orbExtent(other) + 10)) continue;
        fallback ||= candidate;
        const outsideConstellations = edges.every((edge) => (
          distanceToSegment(candidate, edge.a, edge.b) > extent + 16
        ));
        if (!preferOpenSky || outsideConstellations) {
          fallback = candidate;
          break;
        }
      }
      if (fallback) {
        if (design === "black-hole") {
          const horizonScale = fallback.blackHoleShadowScale / schwarzschildCriticalImpact;
          fallback.blackHoleImages = fallback.blackHoleBandScales.map((bandScale) => {
            const sourceRadius = fallback.blackHoleScale * bandScale / horizonScale;
            return {
              direct: traceSchwarzschildRing(
                sourceRadius, fallback.blackHoleSquash, fallback.blackHoleAngles, "direct",
              ),
              firstIndirect: traceSchwarzschildRing(
                sourceRadius, fallback.blackHoleSquash, fallback.blackHoleAngles, "indirect",
              ),
              secondIndirect: traceSchwarzschildRing(
                sourceRadius, fallback.blackHoleSquash, fallback.blackHoleAngles, "direct", 1,
              ),
            };
          });
          const outerDirect = fallback.blackHoleImages[0].direct;
          const innerDirect = fallback.blackHoleImages[fallback.blackHoleImages.length - 1].direct;
          fallback.blackHoleImages.forEach((band) => {
            band.visibleFirstIndirect = clipPathOutsideAnnulus(
              band.firstIndirect, outerDirect, innerDirect,
            );
            band.visibleSecondIndirect = clipPathOutsideAnnulus(
              band.secondIndirect, outerDirect, innerDirect,
            );
          });
        }
        orbs.push(fallback);
      }
    }
    const freeStars = stars.filter((star) => !connectedStars.has(star));
    const driftCount = Math.min(freeStars.length, Math.max(4, Math.min(18, Math.round(stars.length * .14))));
    [...freeStars].sort((a, b) => a.driftRank - b.driftRank).slice(0, driftCount).forEach((star, index) => {
      star.driftRadius = 4 + Math.pow(random(510 + index), 2) * 196;
      const driftSpeed = .05 + random(1510 + index) * .05;
      star.driftRate = driftSpeed / 1000 / star.driftRadius;
    });
    bodies = [...stars, ...orbs];
    scrollOrigin = window.scrollY;
    requestDraw();
  }

  function draw(now = performance.now()) {
    frame = 0;
    sky.clearRect(0, 0, width, height);
    const scrollOffset = reducedMotion.matches ? 0 : window.scrollY - scrollOrigin;
    const pointerPosition = {
      x: pointer.clientX,
      y: pointer.clientY,
    };
    const nearby = pointer.active ? bodies
      .map((body) => ({ body, distance: Math.hypot(pointerPosition.x - body.x, pointerPosition.y - (body.y - scrollOffset * body.parallax)) }))
      .filter(({ distance }) => distance < 180)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 4) : [];
    const influence = new Map(nearby.map(({ body, distance }) => [body, 1 - distance / 180]));
    let moving = false;
    bodies.forEach((body) => {
      const baseY = body.y - scrollOffset * body.parallax;
      const pull = influence.get(body) || 0;
      const targetX = pull ? (pointerPosition.x - body.x) * body.pullStrength * pull : 0;
      const targetY = pull ? (pointerPosition.y - baseY) * body.pullStrength * pull : 0;
      body.attractionX += (targetX - body.attractionX) * .12;
      body.attractionY += (targetY - body.attractionY) * .12;
      body.glow += (pull - body.glow) * .12;
      if (Math.abs(targetX - body.attractionX) > .04 || Math.abs(targetY - body.attractionY) > .04 || Math.abs(pull - body.glow) > .01) moving = true;
    });
    const renderBodies = (attractionScale) => new Map(bodies.map((body) => {
      const driftRadius = reducedMotion.matches ? 0 : (body.driftRadius || 0);
      const driftAngle = now * (body.driftRate || 0) + (body.driftPhase || 0);
      return [body, {
        x: body.x + Math.cos(driftAngle) * driftRadius + body.attractionX * attractionScale,
        y: body.y - scrollOffset * body.parallax + Math.sin(driftAngle * .83) * driftRadius + body.attractionY * attractionScale,
        glow: body.glow,
      }];
    }));
    const movingEdges = edges.filter(({ a, b }) => [a, b].some((body) => (
      influence.has(body) || Math.abs(body.attractionX) + Math.abs(body.attractionY) > .04
    )));
    const edgesCross = (points) => movingEdges.some((edge) => edges.some((other) => edge !== other && intersects(
      { a: points.get(edge.a), b: points.get(edge.b), sourceA: edge.a, sourceB: edge.b },
      { a: points.get(other.a), b: points.get(other.b), sourceA: other.a, sourceB: other.b },
    )));
    let attractionScale = 1;
    let rendered = renderBodies(attractionScale);
    if (movingEdges.length && edgesCross(rendered)) {
      let safe = 0;
      let unsafe = 1;
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const candidate = (safe + unsafe) / 2;
        if (edgesCross(renderBodies(candidate))) unsafe = candidate;
        else safe = candidate;
      }
      attractionScale = safe;
      rendered = renderBodies(attractionScale);
    }
    const drawBlackHole = (orb) => {
      const point = rendered.get(orb);
      const core = orb.warmth > .5 ? "220, 193, 137" : "157, 185, 220";
      const shadowRadius = orb.radius * orb.blackHoleShadowScale;
      const horizonRadius = shadowRadius / schwarzschildCriticalImpact;
      const toScreen = (target) => ({
        x: target.x * horizonRadius,
        y: target.y * horizonRadius,
      });
      const appendPoints = (points) => points.forEach((target, pointIndex) => {
        const screenPoint = toScreen(target);
        if (pointIndex) sky.lineTo(screenPoint.x, screenPoint.y);
        else sky.moveTo(screenPoint.x, screenPoint.y);
      });
      const strokeRuns = (runs) => {
        sky.beginPath();
        runs.forEach(appendPoints);
        sky.stroke();
      };
      const strokeDirectRuns = (points, foreground) => {
        sky.beginPath();
        let drawing = false;
        for (let index = 0; index < points.length - 1; index += 1) {
          const source = points[index];
          const target = points[index + 1];
          const sourceVisible = source.foreground === foreground;
          const targetVisible = target.foreground === foreground;
          const sourcePoint = toScreen(source);
          const targetPoint = toScreen(target);
          const transition = {
            x: (sourcePoint.x + targetPoint.x) / 2,
            y: (sourcePoint.y + targetPoint.y) / 2,
          };
          if (sourceVisible && !drawing) {
            sky.moveTo(sourcePoint.x, sourcePoint.y);
            drawing = true;
          }
          if (sourceVisible && targetVisible) sky.lineTo(targetPoint.x, targetPoint.y);
          else if (sourceVisible) {
            sky.lineTo(transition.x, transition.y);
            drawing = false;
          } else if (targetVisible) {
            sky.moveTo(transition.x, transition.y);
            sky.lineTo(targetPoint.x, targetPoint.y);
            drawing = true;
          }
        }
        sky.stroke();
      };
      sky.save();
      sky.translate(point.x, point.y);
      sky.rotate(orb.blackHoleAngle);
      sky.lineCap = "round";
      sky.shadowColor = `rgba(${core}, ${.28 + point.glow * .34})`;
      sky.shadowBlur = .3 + point.glow * 2;
      // Extra windings converge below pixel resolution, so one capped line represents the family.
      sky.globalAlpha = .28;
      sky.lineWidth = .4;
      sky.strokeStyle = `rgba(${core}, ${.16 + point.glow * .14})`;
      strokeRuns(orb.blackHoleImages[0].visibleSecondIndirect);
      sky.globalAlpha = .7;
      sky.lineWidth = .65;
      sky.strokeStyle = `rgba(${core}, ${.18 + point.glow * .16})`;
      orb.blackHoleImages.forEach((band) => strokeRuns(band.visibleFirstIndirect));
      sky.globalAlpha = .88;
      sky.lineWidth = .75;
      sky.strokeStyle = `rgba(${core}, ${.2 + point.glow * .18})`;
      orb.blackHoleImages.forEach((band) => strokeDirectRuns(band.direct, false));
      sky.globalAlpha = 1;
      sky.shadowBlur = 0;
      const outerDirect = orb.blackHoleImages[0].direct;
      const innerDirect = orb.blackHoleImages[orb.blackHoleImages.length - 1].direct;
      sky.save();
      sky.beginPath();
      sky.arc(0, 0, shadowRadius, 0, Math.PI * 2);
      sky.clip();
      sky.beginPath();
      sky.arc(0, 0, shadowRadius, 0, Math.PI * 2);
      appendPoints(outerDirect);
      appendPoints(innerDirect);
      sky.fillStyle = "rgba(1, 4, 10, .22)";
      sky.fill("evenodd");
      sky.restore();
      sky.shadowBlur = .3 + point.glow * 2;
      orb.blackHoleImages.forEach((band) => strokeDirectRuns(band.direct, true));
      sky.restore();
    };
    edges.forEach((edge) => {
      const a = rendered.get(edge.a);
      const b = rendered.get(edge.b);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy);
      const startGap = edge.a.radius + 4;
      const endGap = edge.b.radius + 4;
      sky.strokeStyle = "rgba(220, 193, 137, .24)";
      sky.lineWidth = .75;
      sky.beginPath();
      sky.moveTo(a.x + dx / distance * startGap, a.y + dy / distance * startGap);
      sky.lineTo(b.x - dx / distance * endGap, b.y - dy / distance * endGap);
      sky.stroke();
    });
    const strokeOccludedEllipse = (planetRadius, ellipseRadius, squash, angle) => {
      sky.save();
      sky.rotate(angle);
      sky.save();
      sky.beginPath();
      sky.rect(-ellipseRadius - 4, -ellipseRadius - 4, ellipseRadius * 2 + 8, ellipseRadius * 2 + 8);
      sky.arc(0, 0, planetRadius + 1.25, 0, Math.PI * 2);
      sky.clip("evenodd");
      sky.scale(1, squash);
      sky.beginPath();
      sky.arc(0, 0, ellipseRadius, Math.PI, Math.PI * 2);
      sky.stroke();
      sky.restore();
      sky.save();
      sky.scale(1, squash);
      sky.beginPath();
      sky.arc(0, 0, ellipseRadius, 0, Math.PI);
      sky.stroke();
      sky.restore();
      sky.restore();
    };
    orbs.forEach((orb) => {
      const point = rendered.get(orb);
      const radius = orb.radius;
      const core = orb.warmth > .5 ? "220, 193, 137" : "157, 185, 220";
      sky.strokeStyle = `rgba(${core}, ${.2 + point.glow * .18})`;
      sky.lineWidth = .75;
      sky.lineCap = "round";
      sky.shadowColor = `rgba(${core}, ${.28 + point.glow * .34})`;
      sky.shadowBlur = 2 + point.glow * 7;
      sky.save();
      sky.translate(point.x, point.y);
      sky.rotate(orb.angle);
      if (orb.design === "crest") {
        const innerRadius = radius * orb.crestInnerScale;
        const innerOffset = radius * orb.crestOffsetScale;
        const intersectionX = (radius ** 2 - innerRadius ** 2 + innerOffset ** 2) / (2 * innerOffset);
        const intersectionY = Math.sqrt(Math.max(0, radius ** 2 - intersectionX ** 2));
        const outerTipAngle = Math.atan2(intersectionY, intersectionX);
        const innerTipAngle = Math.atan2(intersectionY, intersectionX - innerOffset);
        sky.beginPath();
        sky.arc(0, 0, radius, outerTipAngle, Math.PI * 2 - outerTipAngle);
        sky.arc(innerOffset, 0, innerRadius, -innerTipAngle, innerTipAngle, true);
        sky.closePath();
        sky.stroke();
      } else if (orb.design === "beaded") {
        const beadRadius = Math.max(2, Math.min(4, radius * .11));
        const angles = Array.from({ length: orb.beadCount }, (_, index) => (
          orb.beadStart + index * (Math.PI * 2 / orb.beadCount)
        )).sort((a, b) => a - b);
        const gap = Math.asin(Math.min(.45, (beadRadius + 1.25) / radius));
        angles.forEach((angle, index) => {
          const next = angles[(index + 1) % angles.length] + (index === angles.length - 1 ? Math.PI * 2 : 0);
          sky.beginPath();
          sky.arc(0, 0, radius, angle + gap, next - gap);
          sky.stroke();
        });
        angles.forEach((angle, index) => {
          sky.beginPath();
          sky.arc(Math.cos(angle) * radius, Math.sin(angle) * radius, beadRadius * (index === 0 ? 1 : .78), 0, Math.PI * 2);
          if (index === 0 && orb.beadCount > 1) sky.stroke();
          else {
            sky.fillStyle = `rgba(${core}, ${.2 + point.glow * .18})`;
            sky.fill();
          }
        });
      } else if (orb.design !== "black-hole") {
        sky.beginPath();
        sky.arc(0, 0, radius, 0, Math.PI * 2);
        sky.stroke();
      }
      if (orb.design === "ringed") {
        strokeOccludedEllipse(radius, radius * orb.ringScale, orb.ringSquash, orb.ringAngle - orb.angle);
      }
      if (orb.design === "orbital") {
        const orbitAngle = orb.orbitAngle - orb.angle;
        const outerOrbitRadius = radius * orb.orbitScale * (1 + (orb.orbitCount - 1) * .16);
        for (let orbitIndex = 0; orbitIndex < orb.orbitCount; orbitIndex += 1) {
          const orbitRadius = radius * orb.orbitScale * (1 + orbitIndex * .16);
          strokeOccludedEllipse(radius, orbitRadius, orb.orbitSquash, orbitAngle);
        }
        sky.save();
        sky.rotate(orbitAngle);
        sky.beginPath();
        sky.arc(
          Math.cos(orb.orbitPhase) * outerOrbitRadius,
          Math.sin(orb.orbitPhase) * outerOrbitRadius * orb.orbitSquash,
          orb.orbitMoonRadius,
          0,
          Math.PI * 2,
        );
        sky.fillStyle = `rgba(${core}, ${.2 + point.glow * .18})`;
        sky.fill();
        sky.restore();
      }
      if (orb.design === "halo") {
        for (let haloIndex = 0; haloIndex < orb.haloCount; haloIndex += 1) {
          const haloRadius = radius * (1.12 + (orb.haloScale - 1.12) * (haloIndex + 1) / orb.haloCount);
          const phase = orb.haloPhase + haloIndex * .5;
          const gap = .18 + haloIndex * .04;
          sky.beginPath();
          sky.arc(0, 0, haloRadius, phase + gap, phase + Math.PI - gap);
          sky.moveTo(
            Math.cos(phase + Math.PI + gap) * haloRadius,
            Math.sin(phase + Math.PI + gap) * haloRadius,
          );
          sky.arc(0, 0, haloRadius, phase + Math.PI + gap, phase + Math.PI * 2 - gap);
          sky.stroke();
        }
      }
      if (orb.design === "conjunction") {
        const conjunctionAngle = orb.conjunctionAngle - orb.angle;
        const companionDistance = radius * orb.conjunctionDistance;
        sky.save();
        sky.rotate(conjunctionAngle);
        sky.beginPath();
        sky.arc(0, 0, companionDistance, -Math.PI * .82, -Math.PI * .08);
        sky.stroke();
        sky.beginPath();
        sky.arc(companionDistance, 0, radius * orb.companionScale, 0, Math.PI * 2);
        sky.stroke();
        sky.restore();
      }
      if (orb.design === "cratered") {
        sky.save();
        sky.beginPath();
        sky.arc(0, 0, radius - .5, 0, Math.PI * 2);
        sky.clip();
        orb.craters.forEach((crater) => {
          const craterRadius = crater.dot ? .7 : crater.radius * radius;
          sky.beginPath();
          sky.arc(crater.x * radius, crater.y * radius, craterRadius, 0, Math.PI * 2);
          if (crater.dot) {
            sky.fillStyle = `rgba(${core}, ${.2 + point.glow * .18})`;
            sky.fill();
          } else {
            sky.stroke();
          }
        });
        sky.restore();
      }
      if (orb.design === "gas-giant") {
        if (orb.gasStyle === "contour") {
          sky.save();
          sky.beginPath();
          sky.arc(0, 0, radius - .5, 0, Math.PI * 2);
          sky.clip();
          for (let bandIndex = 0; bandIndex < orb.gasBandCount; bandIndex += 1) {
            const baseY = orb.gasBandPositions[bandIndex] * radius;
            sky.beginPath();
            for (let step = 0; step <= 24; step += 1) {
              const x = radius * (step / 12 - 1);
              const y = baseY
                + Math.sin(x / radius * 3 + orb.gasPhase) * radius * orb.gasFlow
                + Math.sin(x / radius * 6 - orb.gasPhase) * radius * orb.gasFlow * .32;
              if (step === 0) sky.moveTo(x, y);
              else sky.lineTo(x, y);
            }
            sky.stroke();
          }
          sky.restore();
        } else {
          sky.save();
          sky.beginPath();
          sky.arc(0, 0, radius - .5, 0, Math.PI * 2);
          sky.clip();
          for (let bandIndex = 0; bandIndex < orb.gasBandCount; bandIndex += 1) {
            const y = orb.gasBandPositions[bandIndex] * radius;
            sky.beginPath();
            sky.moveTo(-radius, y);
            sky.lineTo(radius, y);
            sky.stroke();
          }
          sky.restore();
        }
      }
      if (orb.design === "sun") {
        const sunRadius = radius * .25;
        sky.beginPath();
        sky.arc(0, 0, sunRadius, 0, Math.PI * 2);
        sky.stroke();
        for (let ray = 0; ray < orb.rayCount; ray += 1) {
          const angle = ray * Math.PI * 2 / orb.rayCount;
          sky.beginPath();
          sky.moveTo(Math.cos(angle) * radius * .36, Math.sin(angle) * radius * .36);
          sky.lineTo(Math.cos(angle) * radius * .53, Math.sin(angle) * radius * .53);
          sky.stroke();
        }
      }
      sky.restore();
      sky.shadowBlur = 0;
    });
    if (reducedMotion.matches) {
      blinkingStar = null;
      if (now >= nextBlinkAt) scheduleBlink(now);
    } else if (!blinkingStar && now >= nextBlinkAt) launchBlink(now);
    let blinking = false;
    let blinkStrength = 0;
    if (blinkingStar) {
      const progress = Math.min(1, (now - blinkingStar.start) / blinkingStar.duration);
      if (progress >= 1) blinkingStar = null;
      else {
        blinking = true;
        blinkStrength = Math.sin(progress * Math.PI) * blinkingStar.power;
      }
    }
    stars.forEach((star) => {
      const point = rendered.get(star);
      const blink = blinkingStar?.star === star ? blinkStrength : 0;
      const radius = star.radius + point.glow * (star.bright ? 1.4 : .6) + blink * 1.7;
      sky.fillStyle = `rgba(239, 227, 206, ${Math.min(1, star.opacity + point.glow * (star.bright ? .52 : .28) + blink * .42)})`;
      sky.shadowColor = "rgba(255, 241, 203, .8)";
      sky.shadowBlur = (star.bright ? 2 : .4) + point.glow * 10 + blink * 9;
      if (star.spiked) {
        sky.beginPath();
        sky.moveTo(point.x, point.y - radius * 2.2);
        sky.lineTo(point.x + radius * .65, point.y - radius * .35);
        sky.lineTo(point.x + radius * 2.2, point.y);
        sky.lineTo(point.x + radius * .65, point.y + radius * .35);
        sky.lineTo(point.x, point.y + radius * 2.2);
        sky.lineTo(point.x - radius * .65, point.y + radius * .35);
        sky.lineTo(point.x - radius * 2.2, point.y);
        sky.lineTo(point.x - radius * .65, point.y - radius * .35);
        sky.closePath();
        sky.fill();
      } else {
        sky.beginPath();
        sky.arc(point.x, point.y, radius, 0, Math.PI * 2);
        sky.fill();
      }
      sky.shadowBlur = 0;
    });
    if (reducedMotion.matches) {
      shootingStar = null;
      if (now >= nextShootingAt) scheduleShootingStar(now);
    } else if (!shootingStar && now >= nextShootingAt) launchShootingStar(now);
    let shooting = false;
    if (shootingStar) {
      const progress = Math.min(1, (now - shootingStar.start) / shootingStar.duration);
      if (progress >= 1) {
        shootingStar = null;
      } else {
        shooting = true;
        const opacity = Math.sin(progress * Math.PI);
        const tailProgress = Math.max(0, progress - .22);
        const headX = shootingStar.x + shootingStar.dx * progress;
        const headY = shootingStar.y + shootingStar.dy * progress;
        sky.save();
        sky.strokeStyle = `rgba(239, 227, 206, ${opacity * .72})`;
        sky.fillStyle = `rgba(255, 246, 220, ${opacity * .88})`;
        sky.lineWidth = .85;
        sky.lineCap = "round";
        sky.shadowColor = "rgba(255, 241, 203, .72)";
        sky.shadowBlur = 5;
        sky.beginPath();
        sky.moveTo(shootingStar.x + shootingStar.dx * tailProgress, shootingStar.y + shootingStar.dy * tailProgress);
        sky.lineTo(headX, headY);
        sky.stroke();
        sky.beginPath();
        sky.arc(headX, headY, 1.35, 0, Math.PI * 2);
        sky.fill();
        sky.restore();
      }
    }
    orbs.filter((orb) => orb.design === "black-hole").forEach(drawBlackHole);
    if (moving || blinking || shooting) scheduleDraw(34);
    else if (!document.hidden && !reducedMotion.matches && stars.some((star) => star.driftRadius)) scheduleDraw(100);
  }

  function scheduleDraw(delay = 34) {
    if (frame || drawTimer) return;
    drawTimer = window.setTimeout(() => {
      drawTimer = 0;
      requestDraw();
    }, delay);
  }

  function requestDraw() {
    if (drawTimer) {
      clearTimeout(drawTimer);
      drawTimer = 0;
    }
    if (!frame) frame = requestAnimationFrame(draw);
  }
  scene.addEventListener("pointermove", (event) => {
    if (reducedMotion.matches) return;
    pointer = { clientX: event.clientX, clientY: event.clientY, active: true };
    requestDraw();
  }, { passive: true });
  scene.addEventListener("pointerleave", () => {
    pointer.active = false;
    requestDraw();
  }, { passive: true });
  window.addEventListener("scroll", () => {
    if (!reducedMotion.matches) requestDraw();
  }, { passive: true });
  reducedMotion.addEventListener("change", () => {
    shootingStar = null;
    blinkingStar = null;
    scheduleShootingStar(performance.now());
    scheduleBlink(performance.now());
    requestDraw();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) requestDraw();
  });
  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      generate();
    });
  }, { passive: true });
  generate();
}
startAtlasSky();
TouchzoukUI.bindPointerShine(document.querySelectorAll(".site-nav a, .atlas-admin-link, .atlas-intro h1, .atlas-player .icon-control, .mobile-category-tabs button"));

const formatDuration = (seconds) => {
  if (!Number.isFinite(seconds)) return "—:—";
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return `${hours ? `${hours}:` : ""}${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
};

function timedContent(item = state.current) {
  return item?.timed_content || { entries: [], text: "", markers: [], pauses: [] };
}

function eligibleEntries(item = state.current, durationSeconds = audio.duration || item?.duration_seconds || 0) {
  const durationMS = durationSeconds * 1000;
  return (timedContent(item).entries || []).filter((entry) => entry.time_ms < durationMS);
}

function collapsedRanges(markers) {
  const ranges = [];
  for (let index = 0; index < markers.length - 1;) {
    const left = markers[index];
    let end = index;
    while (end + 1 < markers.length && markers[end + 1].time_ms === left.time_ms && markers[end + 1].offset > markers[end].offset) end += 1;
    if (end > index) ranges.push({ start: left.offset, end: markers[end].offset, time_ms: left.time_ms });
    index = Math.max(index + 1, end + 1);
  }
  return ranges;
}

function currentIndexAt(items, timeMS, timeKey = "time_ms") {
  let current = -1;
  for (let index = 0; index < items.length; index += 1) {
    if (items[index][timeKey] > timeMS) break;
    current = index;
  }
  return current;
}

function lyricLines(item = state.current, durationSeconds = item?.duration_seconds || 0) {
  const content = timedContent(item);
  const runes = Array.from(content.text || "");
  if (!runes.length) return [];
  const lines = [];
  let start = 0;
  runes.forEach((rune, index) => {
    if (rune !== "\n") return;
    if (index > start) lines.push({ text: runes.slice(start, index).join(""), start, end: index });
    start = index + 1;
  });
  if (start < runes.length) lines.push({ text: runes.slice(start).join(""), start, end: runes.length });
  const markers = [...(content.markers || [])].sort((left, right) => left.offset - right.offset || left.time_ms - right.time_ms);
  const collapsed = collapsedRanges(markers);
  const durationMS = durationSeconds * 1000;
  const pauses = [...(content.pauses || [])].sort((left, right) => left - right);
  const pauseCountBefore = (offset) => {
    let low = 0;
    let high = pauses.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (pauses[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const pauseCountAt = (offset) => pauseCountBefore(offset + 1) - pauseCountBefore(offset);
  const usedAtOffset = new Map();
  const timingMarkers = markers.map((marker) => {
    const index = usedAtOffset.get(marker.offset) || 0;
    usedAtOffset.set(marker.offset, index + 1);
    const pausesAtOffset = pauseCountBefore(marker.offset + 1) - pauseCountBefore(marker.offset);
    return {
      ...marker,
      position: marker.offset + pauseCountBefore(marker.offset) + (pausesAtOffset && index > 0 ? pausesAtOffset : 0),
    };
  });
  const interpolatedTimeAtPosition = (position) => {
    const exact = timingMarkers.find((marker) => marker.position === position);
    if (exact) return exact.time_ms;
    const finalPosition = runes.length + pauses.length;
    const before = timingMarkers.filter((marker) => marker.position < position).at(-1) || { position: 0, time_ms: 0 };
    const after = timingMarkers.find((marker) => marker.position > position) || { position: finalPosition, time_ms: durationMS };
    if (after.position === before.position) return before.time_ms;
    return Math.round(before.time_ms + (after.time_ms - before.time_ms) * (position - before.position) / (after.position - before.position));
  };
  const interpolatedTime = (offset, afterPause = false) => interpolatedTimeAtPosition(
    offset + pauseCountBefore(offset) + (afterPause ? pauseCountAt(offset) : 0),
  );
  lines.forEach((line) => {
    line.markers = markers.filter((marker) => marker.offset >= line.start && marker.offset <= line.end);
    line.pauses = (content.pauses || []).filter((offset) => offset >= line.start && offset <= line.end).map((offset) => offset - line.start);
    const lineMarkerOffsets = new Set(line.markers.filter((marker) => marker.offset < runes.length).map((marker) => marker.offset));
    const pauseOnlyOffsets = new Set([line.start, line.end]);
    line.pauses.forEach((offset) => pauseOnlyOffsets.add(line.start + offset));
    // Markers bracketing whitespace describe a natural pause, not karaoke syllables.
    for (let offset = line.start; offset < line.end; offset += 1) {
      if (!/\s/u.test(runes[offset]) || !lineMarkerOffsets.has(offset) || !lineMarkerOffsets.has(offset + 1)) continue;
      pauseOnlyOffsets.add(offset);
      pauseOnlyOffsets.add(offset + 1);
    }
    line.time_ms = interpolatedTime(line.start, true);
    line.finish_time_ms = Math.max(line.time_ms, interpolatedTime(line.end));
    line.karaoke = [...lineMarkerOffsets].some((offset) => offset > line.start && offset < line.end && !pauseOnlyOffsets.has(offset));
    const collapsedRange = collapsed.find((range) => range.start <= line.start && range.end >= line.end);
    line.collapsed = Boolean(collapsedRange);
    if (collapsedRange) {
      line.time_ms = collapsedRange.time_ms;
      line.finish_time_ms = collapsedRange.time_ms;
    }
  });
  lines.forEach((line, index) => { line.end_time_ms = Math.min(lines[index + 1]?.time_ms ?? durationMS, durationMS); });
  const eligible = lines.filter((line) => line.time_ms < durationMS);
  let previousVisible = null;
  eligible.forEach((line) => {
    line.display_time_ms = line.time_ms;
    if (line.collapsed) return;
    line.display_time_ms = previousVisible
      ? Math.min(line.time_ms, Math.max(previousVisible.display_time_ms, previousVisible.finish_time_ms))
      : 0;
    previousVisible = line;
  });
  return eligible;
}

function karaokeState(line, timeMS) {
  if (!line?.markers?.length) return { before: "", active: "", after: line?.text || "", progress: 0, rtl: false };
  const runes = Array.from(line.text);
  const pauses = [...(line.pauses || [])].sort((left, right) => left - right);
  const pauseCountBefore = (offset) => {
    let low = 0;
    let high = pauses.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (pauses[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const usedAtOffset = new Map();
  const points = line.markers.map((marker) => {
    const offset = marker.offset - line.start;
    const index = usedAtOffset.get(offset) || 0;
    usedAtOffset.set(offset, index + 1);
    const pausesAtOffset = pauseCountBefore(offset + 1) - pauseCountBefore(offset);
    return { offset, position: offset + pauseCountBefore(offset) + (pausesAtOffset && index > 0 ? pausesAtOffset : 0), time_ms: marker.time_ms };
  });
  if (points[0].position > 0) points.unshift({ offset: 0, position: 0, time_ms: line.time_ms });
  const finalPosition = runes.length + pauses.length;
  if (points.at(-1).position < finalPosition) {
    points.push({ offset: runes.length, position: finalPosition, time_ms: Math.max(points.at(-1).time_ms + 1, line.end_time_ms) });
  }
  let activeIndex = -1;
  let timingProgress = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    if (timeMS < left.time_ms) break;
    if (timeMS >= right.time_ms) continue;
    activeIndex = index;
    timingProgress = (timeMS - left.time_ms) / Math.max(1, right.time_ms - left.time_ms);
    break;
  }
  if (activeIndex < 0) {
    return timeMS >= points.at(-1).time_ms
      ? { before: line.text, active: "", after: "", progress: 1, rtl: false }
      : { before: "", active: "", after: line.text, progress: 0, rtl: false };
  }
  const left = points[activeIndex];
  const right = points[activeIndex + 1];
  const timingPosition = left.position + (right.position - left.position) * timingProgress;
  let countedPauses = 0;
  let textPosition = timingPosition;
  for (let index = 0; index < pauses.length;) {
    const offset = pauses[index];
    let count = 1;
    while (index + count < pauses.length && pauses[index + count] === offset) count += 1;
    const pauseStart = offset + countedPauses;
    if (timingPosition < pauseStart) {
      textPosition = timingPosition - countedPauses;
      break;
    }
    if (timingPosition < pauseStart + count) {
      textPosition = offset;
      break;
    }
    countedPauses += count;
    textPosition = timingPosition - countedPauses;
    index += count;
  }
  const active = runes.slice(left.offset, right.offset).join("");
  return {
    before: runes.slice(0, left.offset).join(""),
    active,
    after: runes.slice(right.offset).join(""),
    progress: right.offset === left.offset ? 0 : Math.max(0, Math.min(1, (textPosition - left.offset) / (right.offset - left.offset))),
    rtl: /[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(active),
  };
}

function setPrimaryLyric(line, timeMS, karaoke) {
  textCurrent.classList.toggle("is-unsung", Boolean(line) && timeMS < line.time_ms);
  if (!karaoke) {
    const key = `plain:${state.current?.id || ""}:${line?.start ?? -1}:${line?.end ?? -1}`;
    if (textCurrent.dataset.lyricKey !== key) {
      textCurrent.dataset.lyricKey = key;
      textCurrent.textContent = line?.text || "";
    }
    return;
  }
  const segment = karaokeState(line, timeMS);
  const key = `karaoke:${state.current?.id || ""}:${line.start}:${line.end}`;
  if (textCurrent.dataset.lyricKey !== key || !textCurrent.querySelector(".lyric-progress")) {
    textCurrent.dataset.lyricKey = key;
    const before = document.createElement("span");
    const wrapper = document.createElement("span");
    const base = document.createElement("span");
    const fill = document.createElement("span");
    const after = document.createElement("span");
    before.className = "lyric-sung";
    wrapper.className = "lyric-progress";
    base.className = "lyric-sung";
    fill.className = "lyric-next";
    fill.setAttribute("aria-hidden", "true");
    after.className = "lyric-next";
    wrapper.append(base, fill);
    textCurrent.replaceChildren(before, wrapper, after);
  }
  const [before, wrapper, after] = textCurrent.children;
  const [base, fill] = wrapper.children;
  wrapper.classList.toggle("is-rtl", segment.rtl);
  wrapper.style.setProperty("--lyric-fill", `${segment.progress * 100}%`);
  before.textContent = segment.before;
  base.textContent = segment.active;
  fill.textContent = segment.active;
  after.textContent = segment.after;
}

function animatePlayerRows(key) {
  if (state.playerTextKey === key) return;
  state.playerTextKey = key;
  [textPrevious, textCurrent, textNext].forEach((row) => {
    row.classList.remove("is-entering");
    void row.offsetWidth;
    row.classList.add("is-entering");
  });
}

function renderPlayerText() {
  const item = state.current;
  if (!item) return;
  const timeMS = audio.currentTime * 1000;
  if (item.kind === "set") {
    delete textCurrent.dataset.lyricKey;
    textCurrent.classList.remove("is-unsung");
    const entries = eligibleEntries(item);
    if (!entries.length) {
      textPrevious.textContent = "";
      textCurrent.textContent = "No song list available";
      textNext.textContent = "";
      playerText.disabled = true;
      playerText.setAttribute("aria-label", "No song list available");
      animatePlayerRows(`${item.id}:empty`);
      return;
    }
    const index = currentIndexAt(entries, timeMS);
    textPrevious.textContent = entries[index - 1]?.text || "";
    textCurrent.textContent = entries[index]?.text || "";
    textNext.textContent = entries[index + 1]?.text || "";
    playerText.disabled = false;
    playerText.setAttribute("aria-label", index >= 0
      ? `Open full track list. Current song: ${entries[index].text}`
      : `Open full track list. Next song: ${entries[0].text}`);
    animatePlayerRows(`${item.id}:${index}`);
    return;
  }
  const lines = state.lyricLines.filter((line) => !line.collapsed);
  if (!lines.length) {
    delete textCurrent.dataset.lyricKey;
    textCurrent.classList.remove("is-unsung");
    textPrevious.textContent = "";
    textCurrent.textContent = "No lyrics available";
    textNext.textContent = "";
    playerText.disabled = true;
    playerText.setAttribute("aria-label", "No lyrics available");
    animatePlayerRows(`${item.id}:empty`);
    return;
  }
  const index = currentIndexAt(lines, timeMS, "display_time_ms");
  textPrevious.textContent = lines[index - 1]?.text || "";
  setPrimaryLyric(lines[index], timeMS, lines[index]?.karaoke);
  textNext.textContent = lines[index + 1]?.text || "";
  playerText.disabled = false;
  playerText.setAttribute("aria-label", index >= 0
    ? `Open full lyrics. Current lyric: ${lines[index].text}`
    : `Open full lyrics. Next lyric: ${lines[0].text}`);
  animatePlayerRows(`${item.id}:${index}`);
}

function animatePlayerTextWhilePlaying() {
  if (playerTextFrame || !state.playRequested) return;
  const frame = () => {
    playerTextFrame = 0;
    if (!state.playRequested) return;
    if (state.current?.kind === "song") renderPlayerText();
    playerTextFrame = requestAnimationFrame(frame);
  };
  playerTextFrame = requestAnimationFrame(frame);
}

function stopPlayerTextAnimation() {
  if (playerTextFrame) cancelAnimationFrame(playerTextFrame);
  playerTextFrame = 0;
}

function renderPlayerCues() {
  const allEntries = state.current?.kind === "set" ? eligibleEntries() : [];
  const duration = audio.duration || state.current?.duration_seconds || 0;
  if (!duration || !allEntries.length) {
    playerCues.replaceChildren();
    return;
  }
  const buttons = allEntries.map((entry) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "timeline-cue";
    button.style.left = `${Math.min(1, entry.time_ms / 1000 / duration) * 100}%`;
    button.title = entry.text;
    button.setAttribute("aria-label", `${entry.text}, ${formatDuration(entry.time_ms / 1000)}`);
    button.addEventListener("click", (event) => {
      audio.currentTime = event.detail
        ? TouchzoukUI.pointerRatio(event, waveCanvas) * duration
        : Math.min(entry.time_ms / 1000, duration);
      paintProgress();
    });
    button.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      audio.currentTime = Math.min(entry.time_ms / 1000, duration);
      paintProgress();
    });
    return button;
  });
  playerCues.replaceChildren(...buttons);
}

function renderTextDialog() {
  const item = state.current;
  if (!item || playerText.disabled) {
    if (textDialog.open) textDialog.close();
    return;
  }
  const timeMS = audio.currentTime * 1000;
  textDialogTitle.textContent = item.kind === "set" ? `${item.title} · track list` : `${item.title} · lyrics`;
  copyLyrics.hidden = item.kind !== "song";
  copyLyrics.title = "Copy lyrics";
  copyLyrics.setAttribute("aria-label", "Copy lyrics");
  copyLyricsStatus.textContent = "Copy lyrics";
  copyLyricsIcon.removeAttribute("hidden");
  copyLyricsSuccess.setAttribute("hidden", "");
  const values = item.kind === "set" ? eligibleEntries(item) : state.lyricLines;
  const current = currentIndexAt(values, timeMS);
  textDialog.dataset.itemId = item.id;
  const rows = values.map((value, index) => {
    const row = document.createElement("div");
    const time = document.createElement("time");
    const copy = document.createElement("span");
    row.className = `text-dialog-line${index === current ? " is-current" : ""}${value.collapsed ? " is-collapsed" : ""}`;
    if (index === current) row.setAttribute("aria-current", "true");
    if (item.kind === "set") {
      const seekButton = document.createElement("button");
      seekButton.type = "button";
      seekButton.textContent = formatDuration(value.time_ms / 1000);
      seekButton.setAttribute("aria-label", `Go to ${value.text} at ${seekButton.textContent}`);
      seekButton.addEventListener("click", () => {
        audio.currentTime = Math.min(value.time_ms / 1000, audio.duration || item.duration_seconds);
        paintProgress();
      });
      row.append(seekButton, copy);
    } else {
      time.textContent = formatDuration(value.time_ms / 1000);
      row.append(time, copy);
    }
    copy.textContent = value.text;
    return row;
  });
  textDialogBody.replaceChildren(...rows);
}

function updateTextDialogCurrent() {
  if (!textDialog.open || !state.current) return;
  if (textDialog.dataset.itemId !== state.current.id) {
    renderTextDialog();
    return;
  }
  const values = state.current.kind === "set" ? eligibleEntries() : state.lyricLines;
  const current = currentIndexAt(values, audio.currentTime * 1000);
  textDialogBody.querySelectorAll(".text-dialog-line").forEach((row, index) => {
    const isCurrent = index === current;
    row.classList.toggle("is-current", isCurrent);
    if (isCurrent) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
  });
}

playerText.addEventListener("click", () => {
  if (playerText.disabled) return;
  renderTextDialog();
  textDialog.showModal();
});

copyLyrics.addEventListener("click", async () => {
  if (state.current?.kind !== "song") return;
  try {
    const lyrics = state.lyricLines.map((line) => line.text).join("\n");
    await TouchzoukUI.copyText(lyrics);
    copyLyrics.title = "Lyrics copied";
    copyLyrics.setAttribute("aria-label", "Lyrics copied");
    copyLyricsStatus.textContent = "Lyrics copied";
    copyLyricsIcon.setAttribute("hidden", "");
    copyLyricsSuccess.removeAttribute("hidden");
  } catch {
    copyLyrics.title = "Copy failed";
    copyLyrics.setAttribute("aria-label", "Copy failed");
    copyLyricsStatus.textContent = "Copy failed";
    copyLyricsIcon.removeAttribute("hidden");
    copyLyricsSuccess.setAttribute("hidden", "");
  }
});

TouchzoukUI.bindTrackSharing({
  button: shareButton,
  seeker: waveCanvas,
  status: shareStatus,
  getTrackID: () => state.current?.id,
  getCurrentTime: () => audio.currentTime,
  getDuration: () => audio.duration,
  formatTime: formatDuration,
});

const setText = (selector, value, root = document) => {
  const element = root.querySelector(selector);
  if (element) element.textContent = value || "";
};

const itemKicker = (item) => item.kind === "song" ? "Song" : (item.event_name || "DJ set");
const itemLocation = (item) => [item.city, item.country].filter(Boolean).join(" · ");

function renderCatalog(kind) {
  const items = state.catalog[kind];
  const list = document.querySelector(`[data-list="${kind}"]`);
  const count = document.querySelector(`[data-count="${kind}"]`);
  count.textContent = `${items.length}`;
  list.replaceChildren();
  if (!items.length) {
    list.innerHTML = `<div class="atlas-empty">No ${kind === "set" ? "sets" : "songs"} published yet.</div>`;
    return;
  }
  const template = document.querySelector("#media-card-template");
  items.forEach((item) => {
    const card = template.content.firstElementChild.cloneNode(true);
    card.dataset.id = item.id;
    const cover = card.querySelector(".card-cover");
    cover.src = item.cover_url;
    cover.alt = `${item.title} cover`;
    TouchzoukUI.applyCoverCrop(cover, item);
    setText(".card-duration", formatDuration(item.duration_seconds), card);
    const kicker = card.querySelector(".card-kicker");
    if (item.kind === "set" && item.event_name && item.event_url) {
      const link = document.createElement("a");
      link.href = item.event_url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = item.event_name;
      kicker.append(link);
      kicker.classList.add("has-event-link");
    } else {
      kicker.textContent = itemKicker(item);
    }
    setText(".card-title", item.title, card);
    setText(".card-subtitle", item.subtitle, card);
    setText(".card-played-at", item.played_at, card);
    const location = card.querySelector(".card-location");
    const locationLink = TouchzoukUI.createLocationLink(item, "card-location-link");
    if (locationLink) location.replaceWith(locationLink);
    else location.textContent = itemLocation(item);
    const tags = card.querySelector(".card-tags");
    item.tags?.forEach((tag) => {
      const pill = document.createElement("i");
      pill.textContent = tag;
      tags.append(pill);
    });
    const telegram = card.querySelector(".card-telegram");
    if (item.telegram_url) telegram.href = item.telegram_url;
    else telegram.hidden = true;
    const playButton = card.querySelector(".card-load");
    card.querySelector(".card-cover-load").setAttribute("aria-label", `Load ${item.title}`);
    playButton.setAttribute("aria-label", `Play ${item.title}`);
    playButton.addEventListener("click", () => selectItem(item, true));
    card.querySelector(".card-cover-load").addEventListener("click", () => activateItem(item));
    card.querySelector(".card-title").addEventListener("click", () => activateItem(item));
    card.addEventListener("click", (event) => {
      if (!event.target.closest("a, button")) activateItem(item);
    });
    TouchzoukUI.bindPointerShine(card.querySelectorAll("a, button"));
    list.append(card);
  });
  updatePlayState();
}

async function loadCatalog(kind) {
  try {
    const response = await fetch(`/api/media?kind=${kind}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { items } = await response.json();
    state.catalog[kind] = items;
    renderCatalog(kind);
    return true;
  } catch (error) {
    document.querySelector(`[data-list="${kind}"]`).innerHTML = '<div class="atlas-empty">Could not load this list.</div>';
    console.error(error);
    return false;
  }
}

async function selectItem(item, autoplay = false) {
  if (state.current?.id === item.id) {
    if (!autoplay) return;
    if (!state.playRequested) {
      if (audio.ended) audio.currentTime = 0;
      void play();
    } else pausePlayback();
    return;
  }
  state.waveformRequest?.abort();
  state.playIntent += 1;
  state.playRequested = false;
  state.startingPlayback = false;
  const request = new AbortController();
  state.waveformRequest = request;
  if (state.pendingStart?.trackID !== item.id) state.pendingStart = null;
  state.current = item;
  state.playerTextKey = "";
  state.lyricLines = item.kind === "song" ? lyricLines(item) : [];
  state.category = item.kind;
  state.waveform = [];
  state.rebinned.clear();
  audio.src = item.audio_url;
  seek.value = "0";
  setText("[data-current]", "00:00");
  const itemDuration = formatDuration(item.duration_seconds);
  setText("[data-duration]", itemDuration);
  seek.setAttribute("aria-valuetext", `00:00 of ${itemDuration}`);
  playerIdle.hidden = true;
  playerLoaded.hidden = false;
  shareButton.disabled = false;
  const cover = document.querySelector("[data-now-cover]");
  cover.src = item.cover_url;
  cover.alt = `${item.title} cover`;
  TouchzoukUI.applyCoverCrop(cover, item);
  setText("[data-now-kind]", item.kind);
  setText("[data-now-title]", item.title);
  setText("[data-now-subtitle]", item.subtitle || itemKicker(item));
  renderPlayerText();
  if (textDialog.open) renderTextDialog();
  renderPlayerCues();
  document.querySelectorAll(".media-card").forEach((card) => card.classList.toggle("is-loaded", card.dataset.id === item.id));
  syncShuffleButton();
  drawWaveform();
  if (autoplay) void play();
  try {
    const response = await fetch(item.waveform_url, { signal: request.signal, cache: "no-cache" });
    if (!response.ok || state.current?.id !== item.id) return;
    const waveform = await response.json();
    if (state.current?.id !== item.id) return;
    state.waveform = waveform.points || [];
    state.rebinned.clear();
    drawWaveform();
  } catch (error) {
    if (error.name !== "AbortError") console.error(error);
  }
}

function activateItem(item) {
  if (state.current?.id === item.id && state.playRequested) return;
  void selectItem(item, true);
}

async function play() {
  if (!state.current) return;
  const intent = ++state.playIntent;
  const itemID = state.current.id;
  state.playRequested = true;
  state.startingPlayback = true;
  updatePlayState();
  try {
    await audio.play();
    if (intent !== state.playIntent || state.current?.id !== itemID) {
      if (!state.playRequested) audio.pause();
      return;
    }
    state.startingPlayback = false;
    if (!state.playRequested) audio.pause();
  } catch (error) {
    if (intent !== state.playIntent || state.current?.id !== itemID) return;
    state.startingPlayback = false;
    if (!state.playRequested) return;
    state.playRequested = false;
    updatePlayState();
    console.error(error);
  }
}

function pausePlayback() {
  state.playIntent += 1;
  state.playRequested = false;
  state.startingPlayback = false;
  audio.pause();
  updatePlayState();
}

function updatePlayState() {
  const playing = state.playRequested;
  mainPlay.classList.toggle("is-playing", playing);
  mainPlay.setAttribute("aria-label", playing ? "Pause" : "Play");
  document.querySelectorAll(".media-card").forEach((card) => {
    const current = card.dataset.id === state.current?.id;
    card.classList.toggle("is-loaded", current);
    card.classList.toggle("is-playing", current && playing);
    const button = card.querySelector(".card-load");
    const title = card.querySelector(".card-title")?.textContent || "item";
    button.setAttribute("aria-label", current && playing ? `Pause ${title}` : `Play ${title}`);
    button.setAttribute("aria-pressed", String(current && playing));
  });
}

function adjacentItem(offset) {
  const items = state.catalog[state.category];
  if (!items.length || !state.current) return null;
  const index = items.findIndex((item) => item.id === state.current.id);
  return items[(index + offset + items.length) % items.length];
}

function rebinnedPoints(source, targetCount) {
  const cacheKey = `${state.current?.id || "idle"}:${source.length}:${targetCount}`;
  if (state.rebinned.has(cacheKey)) return state.rebinned.get(cacheKey);
  const result = TouchzoukUI.rebinWaveform(source, targetCount);
  state.rebinned.set(cacheKey, result);
  return result;
}

function drawWaveform() {
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const ratio = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.floor(bounds.width * ratio));
  const pixelHeight = Math.max(1, Math.floor(bounds.height * ratio));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);
  const source = state.waveform.length ? state.waveform : fallbackWaveform;
  const pitch = window.innerWidth <= 720 ? 7 : 4.5;
  const targetCount = Math.max(18, Math.min(source.length, Math.floor(bounds.width / pitch)));
  const points = rebinnedPoints(source, targetCount);
  const progress = audio.duration ? audio.currentTime / audio.duration : 0;
  const gap = window.innerWidth <= 720 ? 2.2 : 1.5;
  const step = bounds.width / points.length;
  const barWidth = Math.max(1, step - gap);
  const hoverIndex = state.hoverWaveformRatio == null ? -10 : Math.min(points.length - 1, Math.floor(state.hoverWaveformRatio * points.length));
  points.forEach((point, index) => {
    const hoverDistance = Math.abs(index - hoverIndex);
    const played = progress > 0 && (index + .5) / points.length <= progress;
    const hover = TouchzoukUI.waveformHoverStyle(hoverDistance, played);
    const height = Math.max(2, point * bounds.height * .82 * (hover?.scale || 1));
    context.fillStyle = played ? "#efe3ce" : "rgba(220, 193, 137, .25)";
    if (hover) {
      context.fillStyle = hover.fill;
      context.shadowColor = hover.shadow;
      context.shadowBlur = hover.blur;
    }
    context.fillRect(index * step, (bounds.height - height) / 2, barWidth, height);
    context.shadowBlur = 0;
  });
}

function requestWaveformDraw() {
  if (waveformFrame) return;
  waveformFrame = requestAnimationFrame(() => {
    waveformFrame = 0;
    drawWaveform();
  });
}

function shuffleCatalog() {
  const kind = state.category;
  const items = state.catalog[kind];
  if (items.length < 2) return;
  if (state.shuffled[kind]) {
    const order = state.originalOrder[kind] || [];
    const positions = new Map(order.map((id, index) => [id, index]));
    items.sort((a, b) => (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    state.shuffled[kind] = false;
    state.originalOrder[kind] = null;
    catalogStatus.textContent = `${kind === "set" ? "Sets" : "Songs"} returned to their original order.`;
  } else {
    state.originalOrder[kind] = items.map((item) => item.id);
    const current = state.current?.kind === kind ? items.find((item) => item.id === state.current.id) : null;
    const rest = items.filter((item) => item !== current);
    const previousRest = rest.map((item) => item.id).join(",");
    for (let index = rest.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [rest[index], rest[swap]] = [rest[swap], rest[index]];
    }
    if (rest.length > 1 && rest.map((item) => item.id).join(",") === previousRest) rest.push(rest.shift());
    items.splice(0, items.length, ...(current ? [current, ...rest] : rest));
    state.shuffled[kind] = true;
    catalogStatus.textContent = `${kind === "set" ? "Sets" : "Songs"} shuffled. The loaded track is first.`;
  }
  renderCatalog(kind);
  syncShuffleButton();
}

function syncShuffleButton() {
  const enabled = state.shuffled[state.category];
  shuffleButton.classList.toggle("is-active", enabled);
  shuffleButton.setAttribute("aria-pressed", String(enabled));
  shuffleButton.setAttribute("aria-label", enabled ? "Restore original order" : "Shuffle current list");
}

function setActiveCategory(kind, scroll = false) {
  catalogTabs.dataset.activeKind = kind;
  const switcher = document.querySelector(".mobile-category-tabs");
  switcher.setAttribute("aria-label", `Sound Atlas category, showing ${kind === "set" ? "Sets" : "Songs"}`);
  document.querySelectorAll("[data-mobile-tab]").forEach((button) => {
    const selected = button.dataset.mobileTab === kind;
    const label = button.dataset.mobileTab === "set" ? "Sets" : "Songs";
    button.classList.toggle("is-active", selected);
    button.tabIndex = selected ? -1 : 0;
    button.setAttribute("aria-pressed", String(selected));
    button.setAttribute("aria-label", selected ? `${label} selected` : `Show ${label}`);
  });
  if (scroll) {
    const heading = document.querySelector(`[data-catalog-panel="${kind}"] .shelf-heading h2`);
    heading.scrollIntoView({ behavior: "smooth", block: "start" });
    heading.focus({ preventScroll: true });
  }
}

document.querySelectorAll("[data-mobile-tab]").forEach((button) => button.addEventListener("click", () => setActiveCategory(button.dataset.mobileTab, true)));

mainPlay.addEventListener("click", () => state.playRequested ? pausePlayback() : void play());
document.querySelector("[data-previous]").addEventListener("click", () => { const item = adjacentItem(-1); if (item) selectItem(item, true); });
document.querySelector("[data-next]").addEventListener("click", () => { const item = adjacentItem(1); if (item) selectItem(item, true); });
shuffleButton.addEventListener("click", shuffleCatalog);
repeatButton.addEventListener("click", () => {
  state.repeat = (state.repeat + 1) % 3;
  repeatButton.classList.toggle("repeat-one", state.repeat === 2);
  repeatButton.setAttribute("aria-pressed", String(state.repeat > 0));
  repeatButton.setAttribute("aria-label", ["Repeat off", "Repeat list", "Repeat current item"][state.repeat]);
});

function setVolume(value) {
  audio.volume = Number(value);
  volumePickers.forEach((picker) => {
    picker.value = value;
    picker.style.setProperty("--volume-percent", `${Math.round(Number(value) * 100)}%`);
    picker.setAttribute("aria-valuetext", `${Math.round(Number(value) * 100)} percent`);
  });
}
setVolume(volumePickers[0].value);
volumePickers.forEach((picker) => picker.addEventListener("input", () => setVolume(picker.value)));
waveCanvas.addEventListener("pointermove", (event) => {
  state.hoverWaveformRatio = TouchzoukUI.pointerRatio(event, waveCanvas);
  requestWaveformDraw();
});
waveCanvas.addEventListener("pointerleave", () => {
  state.hoverWaveformRatio = null;
  requestWaveformDraw();
});
TouchzoukUI.bindSeeker({
  input: seek,
  surface: waveCanvas,
  onSeekStart: () => {
    state.seekWasPlaying = state.playRequested;
    state.seeking = true;
  },
  onSeek: (progress) => {
    if (!audio.duration) return;
    seek.value = String(Math.round(progress * 1000));
    audio.currentTime = progress * audio.duration;
    paintProgress();
    if (state.seekWasPlaying && audio.paused && !state.startingPlayback) void play();
  },
  onSeekEnd: () => {
    if (state.seekWasPlaying) void play();
    state.seekWasPlaying = false;
    state.seeking = false;
  },
});
audio.addEventListener("play", () => {
  if (!state.playRequested) {
    audio.pause();
    return;
  }
  animatePlayerTextWhilePlaying();
  updatePlayState();
});
audio.addEventListener("pause", () => {
  if (!state.startingPlayback && !state.seeking) state.playRequested = false;
  if (!state.playRequested) stopPlayerTextAnimation();
  updatePlayState();
});
function paintProgress() {
  seek.value = audio.duration ? String(Math.round(audio.currentTime / audio.duration * 1000)) : "0";
  const current = formatDuration(audio.currentTime);
  const duration = formatDuration(audio.duration);
  setText("[data-current]", current);
  seek.setAttribute("aria-valuetext", `${current} of ${duration}`);
  renderPlayerText();
  updateTextDialogCurrent();
  requestWaveformDraw();
}
audio.addEventListener("timeupdate", paintProgress);
audio.addEventListener("loadedmetadata", () => {
  const pending = state.pendingStart;
  state.pendingStart = null;
  if (pending?.trackID === state.current?.id) audio.currentTime = Math.min(pending.seconds, audio.duration);
  state.lyricLines = state.current?.kind === "song" ? lyricLines(state.current, audio.duration) : [];
  setText("[data-duration]", formatDuration(audio.duration));
  renderPlayerCues();
  if (textDialog.open) renderTextDialog();
  paintProgress();
});
audio.addEventListener("ended", () => {
  stopPlayerTextAnimation();
  if (state.repeat === 2) { audio.currentTime = 0; play(); return; }
  const item = adjacentItem(1);
  const atEnd = state.catalog[state.category].findIndex((candidate) => candidate.id === state.current.id) === state.catalog[state.category].length - 1;
  if (item && (state.repeat === 1 || !atEnd)) selectItem(item, true); else { state.playRequested = false; updatePlayState(); }
});
window.addEventListener("resize", drawWaveform);

if ("mediaSession" in navigator) {
  const mediaActions = {
    play,
    pause: pausePlayback,
    previoustrack: () => document.querySelector("[data-previous]").click(),
    nexttrack: () => document.querySelector("[data-next]").click(),
  };
  Object.entries(mediaActions).forEach(([action, handler]) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (error) {
      if (error.name !== "NotSupportedError") console.error(error);
    }
  });
}

function setMenuOpen(open) {
  menuButton.setAttribute("aria-expanded", String(open));
  menuLabel.textContent = open ? "Close menu" : "Open menu";
  menu.classList.toggle("is-open", open);
}
menuButton.addEventListener("click", () => setMenuOpen(menuButton.getAttribute("aria-expanded") !== "true"));
menu.querySelectorAll('a[href="#sets"], a[href="#songs"]').forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    history.pushState(null, "", link.hash);
    setActiveCategory(link.hash === "#songs" ? "song" : "set", true);
  });
});
menu.addEventListener("click", () => setMenuOpen(false));
window.addEventListener("hashchange", () => {
  if (["#sets", "#songs"].includes(location.hash)) setActiveCategory(location.hash === "#songs" ? "song" : "set", true);
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && menu.classList.contains("is-open")) { setMenuOpen(false); menuButton.focus(); } });

async function preloadFeatured() {
  if (state.current) return;
  try {
    const response = await fetch("/api/featured");
    if (!response.ok) return;
    const item = await response.json();
    if (!state.current) await selectItem(item);
  } catch (error) {
    console.error(error);
  }
}

async function preloadRequested(catalogsLoaded) {
  if (playbackRequest.trackID) {
    const item = [...state.catalog.set, ...state.catalog.song]
      .find((candidate) => candidate.id === playbackRequest.trackID);
    if (item) {
      state.pendingStart = { trackID: item.id, seconds: playbackRequest.seconds };
      setActiveCategory(item.kind);
      await selectItem(item);
      return;
    }
    const failed = catalogsLoaded.includes(false);
    playerIdle.querySelector("strong").textContent = failed ? "Could not load track" : "Track unavailable";
    playerIdle.querySelector("small").textContent = failed
      ? "Please try this shared link again"
      : "This shared track is no longer in the catalog";
    return;
  }
  await preloadFeatured();
}

if (["#sets", "#songs"].includes(location.hash)) setActiveCategory(location.hash === "#songs" ? "song" : "set");
Promise.all([loadCatalog("set"), loadCatalog("song")]).then(preloadRequested);
