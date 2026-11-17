import 'dotenv/config';
import { config } from 'dotenv';
import { resolve } from 'node:path';

const result = config({ path: resolve(__dirname, '../../../../.env') });
if (result.error && (!('code' in result.error) || result.error.code !== 'ENOENT')) {
  throw result.error;
}
