// Code 128 (set C, numeric pairs) for the DANFE access-key barcode. Patterns are bar/space module widths, indexed by symbol value.
const PATTERNS = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112'];
const START_C = 105; const STOP = 106; const QUIET = 10;

export function code128C(digits: string): { symbols: number[]; bars: { x: number; w: number }[]; width: number } {
  if (!/^(\d{2})+$/.test(digits)) throw new Error('Code 128C requires an even number of digits.');
  const data = (digits.match(/\d{2}/g) ?? []).map(Number);
  const check = (START_C + data.reduce((sum, value, index) => sum + value * (index + 1), 0)) % 103;
  const symbols = [START_C, ...data, check, STOP];
  // Elements alternate bar/space, starting with a bar; every pattern has an odd count of bars so parity carries across symbols.
  const bars: { x: number; w: number }[] = []; let x = QUIET;
  symbols.map(symbol => PATTERNS[symbol]).join('').split('').forEach((width, index) => { if (index % 2 === 0) bars.push({ x, w: Number(width) }); x += Number(width); });
  return { symbols, bars, width: x + QUIET };
}
