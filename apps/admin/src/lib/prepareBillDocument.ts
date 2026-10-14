import { documentBytes } from './billDocumentStore';
export async function prepareBillDocument(file: File): Promise<Blob> {
  if (!file.size || file.size > 20 * 1024 * 1024)
    throw new Error('Choose a non-empty image under 20 MB or a PDF under 5 MB.');
  const head = new Uint8Array(await documentBytes(file.slice(0, 12)));
  if (file.type === 'application/pdf') {
    if (file.size > 5 * 1024 * 1024 || String.fromCharCode(...head.slice(0, 5)) !== '%PDF-')
      throw new Error('Choose a valid PDF under 5 MB.');
    return new Blob([await documentBytes(file)], { type: 'application/pdf' });
  }
  const jpeg = head[0] === 255 && head[1] === 216 && head[2] === 255;
  const png = head[0] === 137 && head[1] === 80 && head[2] === 78 && head[3] === 71;
  const webp =
    String.fromCharCode(...head.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...head.slice(8, 12)) === 'WEBP';
  if (!(
    (file.type === 'image/jpeg' && jpeg) ||
    (file.type === 'image/png' && png) ||
    (file.type === 'image/webp' && webp)
  ))
    throw new Error('Choose a JPEG, PNG, WebP image or PDF.');
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    if (bitmap.width * bitmap.height > 48000000)
      throw new Error('This image is too large to process. Crop or scan it first.');
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx)
      throw new Error('Image processing is unavailable. Choose a PDF or use another browser.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.92, 0.87, 0.82, 0.77]) {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/webp', quality),
      );
      if (blob && blob.type === 'image/webp' && blob.size <= 1024 * 1024) return blob;
    }
    throw new Error('Image is still too large to keep readable. Crop or scan it first.');
  } finally {
    bitmap.close();
  }
}
