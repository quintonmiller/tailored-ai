/**
 * Mobile-first card for Amazon purchase actions.
 *
 * Expects `input` to contain:
 *   - url: string (product URL)
 *   - title?: string (product title)
 *   - image?: string (product image URL)
 *   - price?: number (price in USD)
 *   - qty?: number (quantity, defaults to 1)
 */
export function PurchaseAmazonCard(props: { input: Record<string, unknown> }) {
  const { input } = props;
  const url = typeof input.url === "string" ? input.url : undefined;
  const title = typeof input.title === "string" ? input.title : "Amazon Purchase";
  const image = typeof input.image === "string" ? input.image : undefined;
  const price = typeof input.price === "number" ? input.price : undefined;
  const qty = typeof input.qty === "number" ? input.qty : 1;

  return (
    <div className="purchase-amazon-card">
      {image && <img className="purchase-amazon-image" src={image} alt={title} loading="lazy" />}
      <div className="purchase-amazon-body">
        <h3 className="purchase-amazon-title">{title}</h3>
        {price !== undefined && (
          <p className="purchase-amazon-price">
            ${price.toFixed(2)}
            {qty > 1 && ` × ${qty}`}
          </p>
        )}
        {url && (
          <a className="purchase-amazon-link" href={url} target="_blank" rel="noopener noreferrer">
            View on Amazon
          </a>
        )}
      </div>
    </div>
  );
}
