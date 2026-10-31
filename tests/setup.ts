import 'fake-indexeddb/auto';

// Minimal FileReader for three.js GLTFExporter when running under Node.
if (typeof (globalThis as { FileReader?: unknown }).FileReader === 'undefined') {
  class NodeFileReader {
    result: ArrayBuffer | string | null = null;
    onload: ((ev: unknown) => void) | null = null;
    onloadend: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    readAsArrayBuffer(blob: Blob): void {
      blob.arrayBuffer().then(
        (buf) => {
          this.result = buf;
          this.onload?.({ target: this });
          this.onloadend?.({ target: this });
        },
        (err) => this.onerror?.(err),
      );
    }
    readAsDataURL(blob: Blob): void {
      blob.arrayBuffer().then((buf) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
        this.onload?.({ target: this });
        this.onloadend?.({ target: this });
      });
    }
  }
  (globalThis as { FileReader?: unknown }).FileReader = NodeFileReader;
}
