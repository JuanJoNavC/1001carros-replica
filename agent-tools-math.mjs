// Cuota referencial (sistema francés) con la tasa de consumo; misma fórmula que la calculadora del sitio.
export const LOAN_ANNUAL_RATE = 0.1578;
export function loanQuoteServer(price, down, term, annualRate = LOAN_ANNUAL_RATE) {
  price = Math.max(0, Number(price) || 0);
  down = Math.min(Math.max(0, Number(down) || 0), price);
  term = Math.max(1, Number(term) || 60);
  const financed = price - down, r = Math.pow(1 + annualRate, 1 / 12) - 1;
  const monthly = financed > 0 ? financed * r / (1 - Math.pow(1 + r, -term)) : 0;
  return { precio: Math.round(price), entrada: Math.round(down), entrada_pct: price ? Math.round(down / price * 100) : 0, plazo_meses: term, monto_financiado: Math.round(financed), cuota_mensual: Math.round(monthly), intereses_estimados: Math.max(0, Math.round(monthly * term - financed)), tasa_efectiva_anual: "15,78%" };
}
