import { useCallback, useState } from 'react';

export function useToast() {
  const [msg, setMsg] = useState<string | null>(null);

  const show = useCallback((m: string, ms=2200) => {
    setMsg(m);
    window.setTimeout(() => setMsg(null), ms);
  }, []);

  const Toast = msg ? <div className="toast">{msg}</div> : null;
  return { show, Toast };
}
