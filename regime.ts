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
  m5Candles: Candle[],
  m1Candles: Candle[]
) {
  // Cần tối thiểu 50 nến cho mỗi khung giờ
  if (m1Candles.length < 50 || m5Candles.length < 50) {
    return {
      tqs5m: 0,
      tqs1m: 0,
      totalScore: 0,
      regime: "NEUTRAL",
      riskPercent: 0.5
    };
  }

  const calculateTQS = (candles: Candle[]) => {
    const recent = candles.slice(-50);
    let bodySum = 0;
    let rangeSum = 0;
    let bullish = 0;
    let bearish = 0;
    let vwapCrosses = 0;
    let prevAboveVWAP: boolean | null = null;

    const typicalPrices = recent.map(c => (c.high + c.low + c.close) / 3);
    const volumes = recent.map(c => c.volume);
    let cumulativeTPV = 0;
    let cumulativeVolume = 0;

    for (let i = 0; i < recent.length; i++) {
      const c = recent[i];
      const body = Math.abs(c.close - c.open);
      const range = c.high - c.low || 0.000001;

      bodySum += body;
      rangeSum += range;

      if (c.close > c.open) bullish++;
      else if (c.close < c.open) bearish++;

      cumulativeTPV += typicalPrices[i] * (volumes[i] || 1);
      cumulativeVolume += (volumes[i] || 1);
      const vwap = cumulativeTPV / cumulativeVolume;
      const aboveVWAP = c.close > vwap;

      if (prevAboveVWAP !== null && aboveVWAP !== prevAboveVWAP) {
        vwapCrosses++;
      }
      prevAboveVWAP = aboveVWAP;
    }

    const bodyEfficiency = bodySum / rangeSum;
    const directionalConsistency = Math.max(bullish, bearish) / recent.length;
    // vwapRespect: Cực kỳ gắt, quá 8 lần cắt là coi như choppy.
    const vwapRespect = 1 - normalize(vwapCrosses, 1, 8);

    // Tính ATR Ratio để xem volatility có expansion không
    const atr14 = atr(recent, 14);
    const atrHistory: number[] = [];
    for (let j = 15; j <= recent.length; j++) {
      atrHistory.push(atr(recent.slice(0, j), 14));
    }
    const atrMA20 = sma(atrHistory, 20);
    const atrRatio = atr14 / (atrMA20 || 1);

    const score =
      normalize(bodyEfficiency, 0.3, 0.75) * 30 +        // Thân nến phải chiếm >30% range
      normalize(directionalConsistency, 0.55, 0.85) * 30 + // Tỉ lệ nến cùng màu >55%
      vwapRespect * 25 +                                  // Tôn trọng VWAP
      normalize(atrRatio, 0.9, 1.5) * 15;                // Volatility phải duy trì hoặc tăng

    return Number(score.toFixed(1));
  };

  const tqs5m = calculateTQS(m5Candles);
  const tqs1m = calculateTQS(m1Candles);
  const totalScore = tqs5m * 0.6 + tqs1m * 0.4;

  let regime = "NEUTRAL";
  let riskPercent = 0.5;

  if (totalScore > 75) {
    regime = "TREND_EXPANSION";
    riskPercent = 1.0; 
  } else if (totalScore < 40) {
    regime = "CHOPPY";
    riskPercent = 0.1;
  }

  return {
    tqs5m,
    tqs1m,
    totalScore: Number(totalScore.toFixed(1)),
    regime,
    riskPercent
  };
}

