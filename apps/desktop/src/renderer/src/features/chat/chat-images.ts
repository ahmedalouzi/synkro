import type { ChatImage } from '@peep/shared';

/** An image pasted/dropped into the chat input, with a preview URL for the thumbnail. */
export interface PendingImage extends ChatImage {
  id: string;
  previewUrl: string;
}

export const MAX_IMAGES = 4;
const MAX_DIMENSION = 1568;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const JPEG_THRESHOLD_BYTES = 1024 * 1024;

/**
 * Reads an image file, downscaling anything larger than 1568px (vision models
 * don't benefit from more) and re-encoding big screenshots as JPEG.
 */
export async function readChatImage(file: File): Promise<PendingImage> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name || 'File'} is not an image`);
  if (file.size > MAX_INPUT_BYTES) throw new Error(`${file.name || 'Image'} is larger than 20 MB`);

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  let dataUrl = canvas.toDataURL('image/png');
  if (dataUrl.length * 0.75 > JPEG_THRESHOLD_BYTES) dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  const [header, data] = dataUrl.split(',');
  const mimeType = /data:([^;]+)/.exec(header)?.[1] ?? 'image/png';
  return { id: crypto.randomUUID(), mimeType, data, previewUrl: dataUrl };
}

/** Image files from a paste or drop event. */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  return [...data.files].filter((f) => f.type.startsWith('image/'));
}
