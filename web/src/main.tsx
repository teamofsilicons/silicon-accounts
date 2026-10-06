import { render } from "solid-js/web";
import "./styles/fonts";
import "./arc/foundation.css";
import "./styles/tokens.css";
import "./arc/lib/squircle.css";
import "./styles/base.css";
import { App } from "./app/App";

const root = document.getElementById("root");
if (!root) throw new Error("Silicon Accounts could not start: the #root element is missing from index.html.");
render(() => <App />, root);
