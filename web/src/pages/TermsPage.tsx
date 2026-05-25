import termsMarkdown from '../../../docs/legal/TERMS_OF_SERVICE.md?raw';
import { LegalPage } from './LegalPage';

export function TermsPage() {
  return <LegalPage source={termsMarkdown} pageTitle="Terms of Service" />;
}
