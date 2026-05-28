# MilkMate Google Apps Script Backend

This folder contains the backend for the MilkMate Orders app.

The backend reads and writes the Google Sheet created in step 3 and exposes API actions for the frontend.

## Files

```text
Code.gs
appsscript.json
```

## What The Backend Does

- Validates customer and owner login.
- Converts temporary passwords into salted SHA-256 password hashes.
- Reads active milk brands and rates from the `Brands` sheet.
- Saves customer orders into the `Orders` sheet.
- Modifies existing customer orders.
- Marks customer orders as deleted.
- Enforces the 9 PM IST cutoff.
- Calculates owner dashboard totals.
- Sends daily and monthly owner email reports.

## Google Sheet Required

Create the spreadsheet from:

```text
../google-sheets/
```

The spreadsheet must contain these tabs:

```text
Customers
Owners
Brands
Orders
ReportsLog
```

## Setup Steps

1. Open the Google Sheet.
2. Go to `Extensions -> Apps Script`.
3. Delete the default code.
4. Copy the contents of `Code.gs` into the Apps Script editor.
5. Open project settings and add this Script Property:

```text
SPREADSHEET_ID = your_google_sheet_id
```

The sheet ID is the long value in the Google Sheet URL:

```text
https://docs.google.com/spreadsheets/d/SHEET_ID_HERE/edit
```

6. Save the Apps Script project.
7. Run this function once:

```text
hashInitialPasswords
```

This converts `initialPassword` values in `Customers` and `Owners` into:

```text
passwordSalt
passwordHash
```

It also clears the plain `initialPassword`.

8. Run this function once if you want scheduled emails:

```text
installReportTriggers
```

9. Deploy the project:

```text
Deploy -> New deployment -> Web app
```

Recommended deployment settings:

```text
Execute as: Me
Who has access: Anyone
```

Copy the deployed Web App URL. It will be used in step 5 to connect the frontend.

## API Actions

All requests are sent as JSON using `POST`.

### login

```json
{
  "action": "login",
  "role": "customer",
  "userId": "CUST001",
  "password": "milk123"
}
```

For owner login:

```json
{
  "action": "login",
  "role": "owner",
  "userId": "OWNER001",
  "password": "owner123"
}
```

Returns a session token if valid.

### getConfig

```json
{
  "action": "getConfig",
  "token": "SESSION_TOKEN"
}
```

Returns active milk brands and rates.

### getCustomerOrders

```json
{
  "action": "getCustomerOrders",
  "token": "SESSION_TOKEN",
  "month": "2026-05"
}
```

### upsertOrder

```json
{
  "action": "upsertOrder",
  "token": "SESSION_TOKEN",
  "orderDate": "2026-05-27",
  "brandId": "heritage",
  "quantityLitres": 2
}
```

### deleteOrder

```json
{
  "action": "deleteOrder",
  "token": "SESSION_TOKEN",
  "orderDate": "2026-05-27"
}
```

### getOwnerDashboard

```json
{
  "action": "getOwnerDashboard",
  "token": "SESSION_TOKEN",
  "orderDate": "2026-05-27"
}
```

## Notes

- This backend uses `CacheService` for short login sessions.
- Sessions expire after 6 hours.
- Passwords are never stored directly after `hashInitialPasswords` runs.
- The frontend is not connected to this backend until step 5.
