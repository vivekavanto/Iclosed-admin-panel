/** Lead types the customer app prices a quote for. */
export function hasQuote(leadType: string | null | undefined): boolean {
  return /purchase|sale|refinance|condo/i.test(leadType ?? "");
}
