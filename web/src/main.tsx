import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import { installDetailsCloseAnimation } from "./details-close";
import { detectLocale, I18nProvider } from "./i18n";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");
installDetailsCloseAnimation();
const locale = detectLocale();
document.documentElement.lang = locale;
createRoot(root).render(
  <I18nProvider initialLocale={locale}>
    <App />
  </I18nProvider>
);
