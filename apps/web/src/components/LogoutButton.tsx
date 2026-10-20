import { useEffect, useState } from "react";
import { logout, webAuthRequired } from "../api.js";

export function LogoutButton() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    void webAuthRequired()
      .then(setEnabled)
      .catch(() => {});
  }, []);
  return enabled ? (
    <button className="logout-button" type="button" onClick={() => void logout()}>
      Sign out
    </button>
  ) : null;
}
