import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import { installDetailsCloseAnimation } from "./details-close";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");
installDetailsCloseAnimation();
createRoot(root).render(<App />);
