import { ReceiptConfirmationScreen } from "../../../components/receipt-confirmation-screen";
import { translate } from "../../../lib/i18n";
import { getRequestContext } from "../../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "receipt.title")}</h1>
      <ReceiptConfirmationScreen locale={locale} receiptId={id} />
    </main>
  );
}
