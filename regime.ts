export type Candle = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function sma(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / (slice.length || 1);
}

function atr(candles: Candle[], period: number): number {
  if (candles.length < 2) return 0;

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];

    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );

    trs.push(tr);
  }

  return sma(trs, period);
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function normalize(v: number, min: number, max: number) {
  if (max === min) return 0;
  return clamp((v - min) / (max - min), 0, 1);
}

export function calculateMarketRegime(
  d1Candles: Candle[],
  m5Candles: Candle[]
) {
  if (d1Candles.length < 35 || m5Candles.length < 48) {
    return {
      expansionScore: 0,
      trendQualityScore: 0,
      compressionScore: 0,
      regime: "NEUTRAL",
      riskPercent: 0.5
    };
  }

  // =========================
  // DAILY EXPANSION SCORE
  // =========================

  const atr14 = atr(d1Candles, 14);
  const atrHistory: number[] = [];

  // Need at least 20 + 14 candles to have a 20-period SMA of 14-period ATR
  for (let i = 15; i <= d1Candles.length; i++) {
    atrHistory.push(atr(d1Candles.slice(0, i), 14));
  }

  const atrMA20 = sma(atrHistory, 20);
  const lastD1 = d1Candles[d1Candles.length - 1];
  const dailyRange = lastD1.high - lastD1.low;

  const volumeHistory = d1Candles.map(c => c.volume);
  const volumeMA20 = sma(volumeHistory, 20);

  const atrRatio = atr14 / (atrMA20 || 1);
  const rangeRatio = dailyRange / (atr14 || 1);
  const volumeRatio = lastD1.volume / (volumeMA20 || 1);

  const expansionScore =
    normalize(atrRatio, 0.7, 1.3) * 40 +
    normalize(rangeRatio, 0.7, 1.8) * 35 +
    normalize(volumeRatio, 0.7, 1.6) * 25;

  // =========================
  // TREND QUALITY SCORE
  // =========================

  const recentM5 = m5Candles.slice(-48);
  let bodySum = 0;
  let rangeSum = 0;
  let bullish = 0;
  let bearish = 0;
  let vwapCrosses = 0;
  let prevAboveVWAP: boolean | null = null;

  const typicalPrices = recentM5.map(c => (c.high + c.low + c.close) / 3);
  const volumes = recentM5.map(c => c.volume);

  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (let i = 0; i < recentM5.length; i++) {
    const c = recentM5[i];
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;

    bodySum += body;
    rangeSum += (range || 0.000001); // Avoid div by zero

    if (c.close > c.open) bullish++;
    else bearish++;

    cumulativeTPV += typicalPrices[i] * (volumes[i] || 1);
    cumulativeVolume += (volumes[i] || 1);

    const vwap = cumulativeTPV / cumulativeVolume;
    const aboveVWAP = c.close > vwap;

    if (prevAboveVWAP !== null && aboveVWAP !== prevAboveVWAP) {
      vwapCrosses++;
    }
    prevAboveVWAP = aboveVWAP;
  }

  const bodyEfficiency = bodySum / (rangeSum || 1);
  const directionalConsistency = Math.max(bullish, bearish) / recentM5.length;
  const vwapRespect = 1 - normalize(vwapCrosses, 3, 15);

  const trendQualityScore =
    normalize(bodyEfficiency, 0.2, 0.7) * 40 +
    normalize(directionalConsistency, 0.45, 0.8) * 35 +
    vwapRespect * 25;

  // =========================
  // COMPRESSION SCORE
  // =========================

  let insideBars = 0;
  // Check daily compression over last 10 days
  const compressionWindow = d1Candles.slice(-10);
  for (let i = 1; i < compressionWindow.length; i++) {
    const prev = compressionWindow[i - 1];
    const curr = compressionWindow[i];
    if (curr.high < prev.high && curr.low > prev.low) {
      insideBars++;
    }
  }

  const atrCompression = 1 - normalize(atrRatio, 0.7, 1.3);
  const rangeCompression = 1 - normalize(rangeRatio, 0.7, 1.8);
  const insideBarScore = normalize(insideBars, 1, 5);

  const compressionScore =
    atrCompression * 40 +
    rangeCompression * 35 +
    insideBarScore * 25;

  // =========================
  // FINAL DECISION (Loosened thresholds)
  // =========================

  let regime = "NEUTRAL";

  if (
    expansionScore > 60 &&
    trendQualityScore > 55 &&
    compressionScore < 50
  ) {
    regime = "TREND_EXPANSION";
  } else if (compressionScore > 65) {
    regime = "COMPRESSION";
  } else if (trendQualityScore < 35) {
    regime = "CHOPPY";
  }

  // =========================
  // RISK MODEL (Absolute percentages: 2%, 1%, 0.5%, 0.25%)
  // =========================

  let riskPercent = 0;
  switch (regime) {
    case "TREND_EXPANSION":
      riskPercent = 2.0;
      break;
    case "NEUTRAL":
      riskPercent = 1.0;
      break;
    case "COMPRESSION":
      riskPercent = 0.5;
      break;
    case "CHOPPY":
      riskPercent = 0.25;
      break;
    default:
      riskPercent = 1.0;
  }

  return {
    expansionScore: Number(expansionScore.toFixed(1)),
    trendQualityScore: Number(trendQualityScore.toFixed(1)),
    compressionScore: Number(compressionScore.toFixed(1)),
    regime,
    riskPercent
  };
}
