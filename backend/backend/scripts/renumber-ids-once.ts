import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { renumberLotReportIds } from '../src/routes/dashboard/lot-defect-report.js';

renumberLotReportIds()
  .then(() => {
    console.log('✅ id 재정렬 완료');
    process.exit(0);
  })
  .catch((e) => {
    console.error('❌ 오류:', e);
    process.exit(1);
  });
