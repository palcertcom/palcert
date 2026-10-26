import type { ReactNode } from 'react';

export interface DataColumn<Row> {
  readonly key: string;
  /** Plain text: it is also the label a phone shows beside each value. */
  readonly header: string;
  readonly cell: (row: Row) => ReactNode;
  /** The column that names the row; on a phone it heads the card, unlabelled. */
  readonly primary?: boolean;
  /** Right-aligned figures, actions: kept to the end edge in both directions. */
  readonly align?: 'start' | 'end';
}

/**
 * A table that stays a table.
 *
 * On a wide screen it is an ordinary table. Below 48rem each row becomes a
 * card of labelled values, so a phone never has to scroll sideways through a
 * table wider than itself. Changing a table's CSS display makes some browsers
 * drop its table semantics, so the rows and cells carry their ARIA roles
 * explicitly: a screen reader meets the same table at every width.
 */
export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  scrollable = false,
}: {
  caption: string;
  columns: readonly DataColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /**
   * For a table wide enough to scroll sideways on a desktop: the container
   * becomes a labelled, focusable region, so a keyboard user can scroll it too.
   */
  scrollable?: boolean;
}) {
  return (
    <div
      className="pc-table-container pc-table-responsive"
      {...(scrollable ? { role: 'region', 'aria-label': caption, tabIndex: 0 } : {})}
    >
      <table className="pc-table pc-table-stack" role="table">
        <caption className="pc-visually-hidden">{caption}</caption>
        <thead role="rowgroup">
          <tr role="row">
            {columns.map((column) => (
              <th
                key={column.key}
                role="columnheader"
                scope="col"
                data-align={column.align ?? 'start'}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((row) => (
            <tr key={rowKey(row)} role="row">
              {columns.map((column) => (
                <td
                  key={column.key}
                  role="cell"
                  data-label={column.header}
                  data-primary={column.primary ? 'true' : undefined}
                  data-align={column.align ?? 'start'}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
