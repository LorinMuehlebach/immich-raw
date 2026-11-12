// Hands a file the editor made (an export, the presets) to the browser as a download.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // Large JPEGs can take a moment to be picked up.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
