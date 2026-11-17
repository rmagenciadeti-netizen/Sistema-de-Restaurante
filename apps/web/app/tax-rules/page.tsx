'use client';

import { Suspense } from 'react';
import { TaxRulesManager } from '../../components/tax-rules-manager';

export default function TaxRulesPage() {
  return <Suspense fallback={null}><TaxRulesManager /></Suspense>;
}
