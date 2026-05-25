import privacyMarkdown from '../../../docs/legal/PRIVACY_POLICY.md?raw';
import { LegalPage } from './LegalPage';

export function PrivacyPage() {
  return <LegalPage source={privacyMarkdown} pageTitle="Privacy Policy" />;
}
