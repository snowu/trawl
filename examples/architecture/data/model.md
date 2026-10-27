# Data model

## Tables

```mermaid
erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ ORDER_LINE : contains
  BOOK ||--o{ ORDER_LINE : "ordered as"
  AUTHOR }|--|{ BOOK : writes

  CUSTOMER {
    uuid id PK
    string email
    string name
  }
  ORDER {
    uuid id PK
    uuid customer_id FK
    string status
    timestamp placed_at
  }
  ORDER_LINE {
    uuid order_id FK
    uuid book_id FK
    int quantity
  }
  BOOK {
    uuid id PK
    string isbn
    string title
    decimal price
  }
```

## Domain classes

```mermaid
classDiagram
  class Order {
    +UUID id
    +OrderStatus status
    +place()
    +cancel(reason)
  }
  class OrderLine {
    +int quantity
    +subtotal() Money
  }
  class Book {
    +String isbn
    +Money price
  }
  class OrderStatus {
    <<enumeration>>
    DRAFT
    PLACED
    SHIPPED
    CANCELLED
  }
  Order "1" *-- "1..*" OrderLine
  OrderLine --> Book
  Order --> OrderStatus
```
