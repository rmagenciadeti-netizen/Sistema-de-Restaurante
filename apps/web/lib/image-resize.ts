// Shrinks a photo in the browser so it fits the API limit (300 KB): longest side up to 800 px, JPEG with decreasing quality.
const TARGET_BYTES = 280 * 1024;
const bytesOf = (dataUrl: string) => Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);

export async function fileToDataUrl(file: File, maxSide = 800): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Escolha um arquivo de imagem (PNG, JPEG ou WebP).');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Não foi possível processar a imagem neste navegador.');
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  for (const quality of [0.88, 0.8, 0.7, 0.6, 0.5, 0.4]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (bytesOf(dataUrl) <= TARGET_BYTES) return dataUrl;
  }
  throw new Error('A imagem continua grande demais. Escolha uma foto menor.');
}
