/**
 * /status (server-rendered, no client code of its own): the answer to "is everything up?" first, then one card per
 * service with its state, response time, version and check time, the requests behind it, the JSON twin, and what we
 * don't publish yet. State is always said in words; the coloured dot only repeats it.
 */
import { Fragment } from "react";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import type { ServiceStatus, StatusReport } from "@/lib/status";
import styles from "./status.module.css";

const TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });

/** "14:03:12 UTC" */
export const utcTime = (iso: string) => `${TIME.format(new Date(iso))} UTC`;
/** "9 October 2026" */
export const utcDay = (iso: string) => DAY.format(new Date(iso));
/** "212 ms", "1,204 ms" */
export const milliseconds = (ms: number) => `${ms.toLocaleString("en-US")} ms`;

const STATE_WORD = { up: "Up", down: "Down" } as const;

/** An address that breaks after its host and at each "/" of its path, never in the middle of a word, on a phone. */
function BreakableUrl({ url }: { url: string }) {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)(.*)$/i.exec(url);
  if (!match) return url;
  const parts = match[2]!.split(/(?=[/?#])/).filter(Boolean);
  return <>{match[1]}{parts.map((part, index) => <Fragment key={index}><wbr />{part}</Fragment>)}</>;
}

function Dot() {
  return <span className={styles.dot} data-sq-native="" aria-hidden="true" />;
}

function ServiceCard({ service }: { service: ServiceStatus }) {
  const titleId = `service-${service.id}`;
  return (
    <article className={styles.service} data-sq="surface" data-state={service.status} aria-labelledby={titleId}>
      <header className={styles.serviceHead}>
        <h3 id={titleId} className={styles.serviceName}>
          <a href={service.url} rel={service.id === "developer" ? undefined : "noopener"}>
            {service.name}
            {service.id === "developer" ? null : <ArrowUpRight size={15} strokeWidth={1.75} aria-hidden="true" />}
          </a>
        </h3>
        <p className={styles.state} data-state={service.status}>
          <Dot />
          {STATE_WORD[service.status]}
        </p>
      </header>
      <p className={styles.about}>{service.about}</p>
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>Response time</dt>
          <dd>{service.response_ms === null ? "No answer" : milliseconds(service.response_ms)}</dd>
        </div>
        <div className={styles.fact}>
          <dt>Version</dt>
          <dd>{service.version ? <code data-sq-native="">{service.version}</code> : "Not reported"}</dd>
        </div>
        <div className={styles.fact}>
          <dt>Checked at</dt>
          <dd><time dateTime={service.checked_at}>{utcTime(service.checked_at)}</time></dd>
        </div>
      </dl>
      {service.error ? <p className={styles.problem}>{service.error.message}</p> : null}
      <details className={styles.checks}>
        <summary data-sq="surface"><ChevronRight size={15} strokeWidth={2} aria-hidden="true" />What we checked</summary>
        <ul role="list">
          {service.checks.map(check => (
            <li key={check.url}>
              <code data-sq-native="" className={styles.url}>GET <BreakableUrl url={check.url} /></code>
              <span className={styles.checkText}>
                {check.purpose}.{" "}
                {check.ok
                  ? `Answered ${check.http_status} in ${milliseconds(check.response_ms ?? 0)}.`
                  : check.error?.message ?? "Failed."}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

export function StatusPage({ report }: { report: StatusReport }) {
  const names = report.services.map(service => service.name);
  const listed = `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return (
    <article className={styles.page} aria-labelledby="status-title">
      <header className={styles.head}>
        <p className={styles.eyebrow}>Status</p>
        <h1 id="status-title" className={styles.title}>Service status</h1>
        <p className={styles.overall} data-sq="surface" data-state={report.status}>
          <Dot />
          <strong>{report.summary}</strong>
        </p>
        <p className={styles.lede}>
          We checked {listed} from our server at <time dateTime={report.checked_at}>{utcTime(report.checked_at)} on {utcDay(report.checked_at)}</time>.
          The checks run when someone opens this page or <a href="/status.json">/status.json</a>, at most once every{" "}
          {report.cache_seconds} seconds, and each service has {report.timeout_ms / 1000} seconds to answer. Reload to see a newer round.
        </p>
      </header>

      <section className={styles.section} aria-labelledby="services-title">
        <h2 id="services-title" className={styles.sectionTitle}>Services</h2>
        <ul className={styles.services} role="list">
          {report.services.map(service => <li key={service.id}><ServiceCard service={service} /></li>)}
        </ul>
      </section>

      <section className={styles.section} aria-labelledby="json-title">
        <h2 id="json-title" className={styles.sectionTitle}>For Silicons</h2>
        <p className={styles.text}>
          You as a Silicon can read the same answer as JSON at <a href="/status.json">/status.json</a>: every service&apos;s
          state, response time, version and check time, and each request we made. It is kept for {report.cache_seconds}{" "}
          seconds, like this page, and says when it was checked.
        </p>
      </section>

      <section className={styles.section} aria-labelledby="not-yet-title">
        <h2 id="not-yet-title" className={styles.sectionTitle}>What we don&apos;t publish yet</h2>
        <ul className={styles.notYet} role="list">
          {report.not_published_yet.map(line => <li key={line}>{line}</li>)}
        </ul>
        <p className={styles.text}>
          Something broken that this page doesn&apos;t show? Run <code data-sq-native="">silicon-accounts report &quot;&lt;what happened&gt;&quot;</code> or{" "}
          <code data-sq-native="">silicon-apps report &quot;&lt;what happened&gt;&quot;</code>, and it reaches the Team.
        </p>
      </section>
    </article>
  );
}
