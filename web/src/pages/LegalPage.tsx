import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { marked } from 'marked';
import { BrandTagline } from '../components/BrandTagline';

interface Props {
  /** The raw markdown content (imported via Vite ?raw). */
  source: string;
  /** Window title and back-link label, e.g. "Privacy Policy". */
  pageTitle: string;
}

/**
 * Renders a static legal document from its markdown source.
 *
 * The three current pages (Privacy Policy, Terms of Service, Cookie
 * Notice) all use this same shell — only the source changes. The
 * markdown is the single source of truth in docs/legal/ so the
 * attorney's edits flow through unchanged.
 *
 * 0.18.13 — wired alongside the security audit's F-33 finding. The
 * documents are draft-state until the attorney signs off; until they
 * do, the DRAFT banner at the top tells visitors not to rely on the
 * content as final.
 */
export function LegalPage({ source, pageTitle }: Props) {
  const html = useMemo(() => {
    // The source is a static markdown file authored by us. No user
    // input touches this; `marked` output goes straight into innerHTML
    // and that's intentional.
    return marked.parse(source, { async: false }) as string;
  }, [source]);

  // 0.18.13 — make the brand text the literal SmrtCash word with the
  // accent on "Cash" so legal pages match the auth screens visually.
  useEffect(() => {
    const prev = document.title;
    document.title = `${pageTitle} — SmrtCash`;
    return () => {
      document.title = prev;
    };
  }, [pageTitle]);

  return (
    <div className="legal-shell">
      <header className="legal-header">
        <Link to="/" className="brand legal-brand">
          Smrt<span>Cash</span>
        </Link>
        <BrandTagline />
      </header>

      <div className="legal-draft-banner" role="status">
        <strong>Draft — under legal review.</strong> The content below is
        the working draft prepared for review by an attorney. It is not
        yet in force and not a binding agreement between SmrtCash and
        any user. Questions or corrections:{' '}
        <a href="mailto:legal@builditsmrt.com">legal@builditsmrt.com</a>.
      </div>

      <article
        className="legal-body"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />

      <footer className="legal-footer">
        <Link to="/privacy">Privacy Policy</Link>
        <span aria-hidden> · </span>
        <Link to="/terms">Terms of Service</Link>
        <span aria-hidden> · </span>
        <Link to="/cookies">Cookie Notice</Link>
        <span aria-hidden> · </span>
        <Link to="/">Back to SmrtCash</Link>
      </footer>
    </div>
  );
}
