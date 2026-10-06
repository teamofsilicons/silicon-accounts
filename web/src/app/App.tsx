/**
 * The web app's root: the router with every route (pages load lazily), the session, the toast viewport and the
 * first-party sign-in return. Page areas live under src/pages; this file is the only route table (see web/README.md).
 */
import { Route, Router, type RouteSectionProps } from "@solidjs/router";
import { Show, Suspense, lazy, onMount, type JSX } from "solid-js";
import { ToastStack } from "../arc/toast-stack/toast-stack";
import { AccountShell } from "./shell/AccountShell";
import { NotFound } from "./NotFound";
import { notify, installErrorReporter } from "./notify";
import { consumeSignInReturn, installSessionHooks, refreshSession, sessionStatus } from "./session";

const Landing = lazy(() => import("../pages/landing/Landing"));
const Identity = lazy(() => import("../pages/account/Identity"));
const SignInMethods = lazy(() => import("../pages/account/SignInMethods"));
const Apps = lazy(() => import("../pages/account/Apps"));
const Silicons = lazy(() => import("../pages/account/Silicons"));
const Proofs = lazy(() => import("../pages/account/Proofs"));
const Activity = lazy(() => import("../pages/account/Activity"));
const Settings = lazy(() => import("../pages/account/Settings"));
const Developer = lazy(() => import("../pages/developer/Developer"));
const AppDetail = lazy(() => import("../pages/developer/AppDetail"));
const SignIn = lazy(() => import("../pages/auth/SignIn"));
const Authorize = lazy(() => import("../pages/auth/Authorize"));
const Flow = lazy(() => import("../pages/auth/Flow"));
const Device = lazy(() => import("../pages/device/Device"));
// The style guide ships only in development builds (and screenshot runs), never in production.
const Kitchen = import.meta.env.DEV || import.meta.env.VITE_ACCOUNTS_KITCHEN === "1" ? lazy(() => import("../pages/kitchen/Kitchen")) : null;

/** "/" is the identity home for a signed-in Carbon or Silicon and the landing page for everyone else. */
function Home() {
  return (
    <Show when={sessionStatus() === "signed_in"} fallback={<Landing />}>
      <Identity />
    </Show>
  );
}

/** Pages outside the account shell (hosted sign-in, device approval, the style guide) render bare. */
function Bare(props: RouteSectionProps): JSX.Element {
  return <Suspense>{props.children}</Suspense>;
}

function Root(props: RouteSectionProps) {
  return (
    <>
      {props.children}
      <ToastStack label="Notifications" />
    </>
  );
}

export function App() {
  installSessionHooks();
  installErrorReporter();
  // A first-party sign-in just finished (/?code&state): put the saved path back before the router reads the URL.
  const returned = consumeSignInReturn();
  void refreshSession();
  onMount(() => {
    if (returned?.error) notify.info("Sign-in did not finish", returned.error === "access_denied" ? "You cancelled it. Sign in again whenever you are ready." : `The sign-in ended with "${returned.error}". Try again.`);
  });

  return (
    <Router root={Root}>
      <Route component={Bare}>
        <Route path="/sign-in" component={SignIn} />
        <Route path="/authorize" component={Authorize} />
        <Route path="/authorize/flow/:id" component={Flow} />
        <Route path="/device" component={Device} />
        {Kitchen ? <Route path="/__kitchen" component={Kitchen} /> : null}
      </Route>
      <Route component={AccountShell}>
        <Route path="/" component={Home} />
        <Route path="/identity" component={Identity} />
        <Route path="/sign-in-methods" component={SignInMethods} />
        <Route path="/apps" component={Apps} />
        <Route path="/silicons" component={Silicons} />
        <Route path="/proofs" component={Proofs} />
        <Route path="/activity" component={Activity} />
        <Route path="/settings" component={Settings} />
        <Route path="/developer" component={Developer} />
        <Route path="/developer/:appId/:tab?" component={AppDetail} />
      </Route>
      <Route path="*404" component={NotFound} />
    </Router>
  );
}
