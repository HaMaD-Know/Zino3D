import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ImportFile } from '../src/formats/importModel';

export function fixture(name: string): ImportFile & Blob {
  const data = readFileSync(resolve(__dirname, 'fixtures', name));
  return new File([data], name) as unknown as ImportFile & Blob;
}
