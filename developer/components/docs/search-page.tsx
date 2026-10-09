/**
 * The body of /docs/search (server-rendered): a GET form (words, product, kind) and the ranked results, each a plain
 * link to the page or section with where it sits and a snippet. Without a query it offers the common starting points.
 */
import type { ReactNode } from "react";
import { FileText, Hash } from "lucide-react";
import { KIND_KEYS, PRODUCT_KEYS, PRODUCT_LABELS, isProblem, parseKind, parseProduct, parseQuery, search } from "@/lib/docs/api";
import articleStyles from "./doc-article.module.css";
import styles from "./search-page.module.css";

const KIND_LABELS: Record<string, string> = { start: "Start (guides)", learn: "Learn (explanations)", reference: "Reference", overview: "Overview" };

const STARTS = [
  { href: "/docs/apps/start/publish", label: "Publish an app" },
  { href: "/docs/accounts/start/add-sign-in", label: "Add sign-in to your app" },
  { href: "/docs/accounts/start/silicon-account", label: "Get a Silicon account" },
  { href: "/docs/accounts/start/app-verification", label: "Prove your app to other apps" },
  { href: "/docs/accounts/reference/errors", label: "Errors" },
  { href: "/docs/apps/reference/cli", label: "Apps CLI reference" },
];

export function DocsSearchPage({ query: rawQuery, product: rawProduct, kind: rawKind, icon }: { query: string | null; product: string | null; kind: string | null; icon: ReactNode }) {
  const query = rawQuery?.trim() ? parseQuery(rawQuery) : null;
  const product = parseProduct(rawProduct);
  const kind = parseKind(rawKind);
  const problem = [query, product, kind].find(isProblem) ?? null;
  const answer = !problem && typeof query === "string" && !isProblem(product) && !isProblem(kind) ? search({ query, product, kind, limit: 40 }) : null;
  const value = typeof query === "string" ? query : rawQuery ?? "";

  return (
    <div className={articleStyles.layout} data-single="">
      <article className={articleStyles.article}>
        <header className={articleStyles.head}>
          <nav aria-label="Breadcrumb" className={articleStyles.crumbs}><ol role="list"><li><a href="/docs">Docs</a></li></ol></nav>
          <h1 className={articleStyles.title}>Search the docs</h1>
          <p className={articleStyles.lede}>Look up a task, a command, an endpoint or an error code across Silicon Apps and Silicon Accounts.</p>
        </header>

        <div className={styles.search}>
          <form action="/docs/search" method="get" className={styles.form} role="search" aria-label="Docs">
            <label className={styles.field} data-sq="surface">
              <span className={styles.fieldIcon}>{icon}</span>
              <span className="sr-only">Search the docs</span>
              <input className={styles.input} type="search" name="q" defaultValue={value} placeholder="publish an app, invalid_grant, /v1/oauth/token…" maxLength={200} autoComplete="off" spellCheck={false} enterKeyHint="search" />
            </label>
            <div className={styles.filters}>
              <label className={styles.select} data-sq="surface">
                <span className="sr-only">Product</span>
                <select name="product" defaultValue={typeof product === "string" ? product : ""}>
                  <option value="">Both products</option>
                  {PRODUCT_KEYS.map(key => <option key={key} value={key}>{PRODUCT_LABELS[key]}</option>)}
                </select>
              </label>
              <label className={styles.select} data-sq="surface">
                <span className="sr-only">Kind of page</span>
                <select name="kind" defaultValue={typeof kind === "string" ? kind : ""}>
                  <option value="">Every kind of page</option>
                  {[...KIND_KEYS, "overview"].map(key => <option key={key} value={key}>{KIND_LABELS[key]}</option>)}
                </select>
              </label>
              <button type="submit" className={styles.submit} data-sq="surface">Search</button>
            </div>
          </form>
        </div>

        {problem ? (
          <p className={styles.problem} role="alert">{problem.message} {problem.hint}</p>
        ) : answer ? (
          <section aria-labelledby="results-title" className={styles.resultsSection}>
            <h2 id="results-title" className={styles.count}>
              {answer.total ? `${answer.total > answer.results.length ? `Top ${answer.results.length} of ${answer.total}` : answer.total} result${answer.total === 1 ? "" : "s"} for “${answer.query}”` : `No page mentions “${answer.query}”`}
            </h2>
            {answer.results.length ? (
              <ol className={styles.results} role="list">
                {answer.results.map(result => (
                  <li key={result.path}>
                    <a href={result.path} className={styles.result} data-sq="surface">
                      <span className={styles.resultIcon} aria-hidden="true">{result.section ? <Hash size={16} strokeWidth={1.75} /> : <FileText size={16} strokeWidth={1.75} />}</span>
                      <span className={styles.resultText}>
                        <span className={styles.resultTitle}>{result.section ?? result.title}</span>
                        <span className={styles.resultWhere}>{result.section ? `${result.title} · ` : ""}{result.group}</span>
                        {result.snippet ? <span className={styles.resultSnippet}>{result.snippet}</span> : null}
                      </span>
                    </a>
                  </li>
                ))}
              </ol>
            ) : (
              <p className={styles.empty}>Every word has to appear. Try fewer words, an endpoint such as /v1/oauth/token, an error code such as invalid_grant, or a command such as silicon-accounts login.</p>
            )}
          </section>
        ) : (
          <section aria-labelledby="starts-title" className={styles.resultsSection}>
            <h2 id="starts-title" className={styles.count}>Common starting points</h2>
            <ul className={styles.starts} role="list">
              {STARTS.map(start => <li key={start.href}><a href={start.href}>{start.label}</a></li>)}
            </ul>
          </section>
        )}
        <p className={styles.note}>
          Agents can search the same way with <a href="/api/docs/search?q=publish">/api/docs/search</a>.
        </p>
      </article>
    </div>
  );
}
