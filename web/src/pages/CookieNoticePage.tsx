import cookieMarkdown from '../../../docs/legal/COOKIE_NOTICE.md?raw';
import { LegalPage } from './LegalPage';

export function CookieNoticePage() {
  return <LegalPage source={cookieMarkdown} pageTitle="Cookie Notice" />;
}
