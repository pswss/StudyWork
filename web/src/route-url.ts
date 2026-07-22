export function detailUrl(subjectId: number, tab: string): string {
  const params = new URLSearchParams(window.location.search);
  params.set("subject", String(subjectId));
  params.set("tab", tab);
  return `${window.location.pathname}?${params}${window.location.hash}`;
}

export function subjectsUrl(): string {
  const params = new URLSearchParams(window.location.search);
  params.delete("subject");
  params.delete("tab");
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
}
