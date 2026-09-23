# Kotak MF API — Reverse-Engineered Notes

## Encryption
- Algorithm: AES-128-CBC, PKCS7 padding, URL-safe base64
- KEY/IV for all endpoints: `8080808080808080` (KEY2/IV2)
- `encryptDotnet` / `decryptDotnet` in `backend/kotak/crypto.js`

## Base URL
```
https://unificationapi.kotakmf.com/KMFUnification/api/Admin/
```

---

## Login Flow (confirmed working)

| Step | Endpoint | Key Payload Fields | Key Response Fields |
|---|---|---|---|
| 1 | `check/USERDET` | `MOBILE_NO` | — |
| 2 | `GETMOBVALIDATEV2` | `FLAG: GETMOBVALIDATENEW`, `MOBILE_NO`, `PAN`, `TYPE: LOGINNEW` | `Result[0].Invetorlink` (short pre-auth token) |
| 3 | `OTPVALIDATE` | `FLAG: VALIDATEOTPLOGIN`, `USERINFO`, `OTP` | `msgTable[0].Status: Y` |
| 4 | `GETMPINDETBYMOB` | `MOB_NUM`, `DEVICE_ID: WEB` | `Response[0].MPIN_Status` |
| 5 | `CHECKLOGINNEW` | `FLAG: CHECKLOGINNEW`, `USER_NAME`, `MOB_PIN`, `MODE: CHKPIN` | Seeds AWSALB cookie |
| 6 | `INSERTLOGINDETAILS` | `FLAG: INSERT_LOGINDETAILS`, `USER_ID` | **`msgTable[0].Session`** = full Invetorlink (248 hex) |

**Session token** comes from `INSERTLOGINDETAILS` → `msgTable[0].Session`, NOT from CHECKLOGINNEW.

---

## Account Data

| Field | Value |
|---|---|
| PAN | CMCPG6896E |
| Mobile | +917827146759 |
| Email | shuvamdev1707@gmail.com |
| Folio | 15461772 |
| Investor Name | Shuvam Giri |
| Scheme | Kotak ELSS Tax Saver Fund - Growth (Regular Plan) |
| **Scheme Code** | **144** |
| Bank | IDFC FIRST Bank |
| Bank Account | 10144265120 (SB) |
| IFSC | IDFB0020215 |
| Branch | NEW DELHI - KALKAJI BRANCH |
| Broker | ARN-114376 |
| EUIN | E207433 |
| Current Value | ₹91,548 (invested ₹90,000) |
| OTM Mandate | **None registered** |

---

## SIP Endpoints

### Get folio schemes
```
POST GETADMINSCHEMEDETAILS
FLAG: GETIPSCHEME, FOLIO: <folio>, BROKER_FLAG: R, SESSION_VALIDATE: N
```
Returns: `Table[0].SCHEME_CODE` (e.g. 144), `LONG_NAME`

### Get SIP date constraints
```
POST GETSCHEMEDATEDETAILS
FLAG: ALLOWED_DATE, SCHEME_CODE: 144, FREQUENCY_VALUE: OM, INVESTMENT_TYPE: SIP, TYPE: P
```
Returns: `SIP_DATES`, `MIN_INSTALMENTS: 6`, `MIN_AMOUNT: 500`, `SIP_DT` (next available date)

### Get linked bank for autopay
```
POST GETEXITBANKNAME
FLAG: GETEXITBANKNAME, FOLIO: <folio>, PAYMENT_MODE: AUTOPAY
```
Returns: `Table[0].BANKNAME`, `ACNO`, `IFSC_CODE`

### Check OTM mandate
```
POST fetch/pan/otm/det
Body: { PAN, MOBILE }  (NOT the standard authPayload format — still AES encrypted)
```
Returns: mandate info or error `"No mandate has been registered for the given PAN"`

---

## SIP Registration

### Real endpoint: `SIPTRXN` (NOT `REGISTERSIP`)

```json
{
  "FLAG": "SIP",
  "FOLIO": "15461772",
  "folio_no": "15461772",
  "pan": "CMCPG6896E",
  "email": "shuvamdev1707@gmail.com",
  "mobileNo": "7827146759",
  "investorName": "Shuvam Giri",
  "user_id": "7827146759",
  "USER_NAME": "7827146759",
  "USER_TYPE": "POSTLOGIN",
  "payment_mode": "ISIP",
  "data": {
    "schemeOptions": [{
      "schemeCode": "144",
      "SchemeName": "Kotak ELSS Tax Saver Fund - Gr",
      "amount": 5000,
      "idcwOption": "Z",
      "distId": "ARN-114376",
      "euin": "E207433",
      "euinFlag": "Y",
      "riaFlag": "N",
      "frequency": "OM",
      "sipDay": "1",
      "startDate": "01-OCT-2026",
      "endDate": "01-OCT-2029",
      "stepUp": { "frequency": "", "amount": "", "percent": "", "maxCap": "", "regno": "" },
      "specialProduct": "N",
      "specialProductSubOption": ""
    }],
    "bank": {
      "name": "IDFC FIRST Bank",
      "acctNo": "10144265120",
      "acctType": "SB",
      "branch": "NEW DELHI- KALKAJI BRANCH",
      "city": "SOUTH-EAST DELHI",
      "ifscCode": "IDFB0020215"
    },
    "mandateRefId": "",
    "omUMRN": "",
    "payinMech": "ISIP",
    "originTxn": "MKMFONLINE",
    "requestRefno": "",
    "camsMandateRefId": "",
    "otpFlag": "M",
    "otpFlagValue": "7827146759,shuvamdev1707@gmail.com",
    "image": ""
  },
  "totalamt": 5000,
  "SESSION_ID": "<investorLink>",
  "SESSION_VALIDATE": "Y",
  "SOURCE": { "Source": "msite", "OS": "Linux" }
}
```

### Frequency codes (from Angular source)
| Code | Meaning |
|---|---|
| `OM` | Monthly |
| `OW` | Weekly |
| `Q` | Quarterly |
| `H` | Half-Yearly |
| `Y` | Yearly |
| `BZ` | Daily |

### Payment mode values
| Value | Meaning |
|---|---|
| `ISIP` | Billdesk NACH iSIP (no pre-existing mandate needed; creates one inline but may require bank redirect) |
| `UPI_NAC` | UPI autopay mandate (register via `MANDATEREGISTRATION` first) |
| `CAMSOTM` | CAMS OTM mandate |
| `KBOTM` | Kotak Bank OTM mandate |

---

## UPI Mandate Flow (for accounts with no NACH mandate)

### Step 1 — Register mandate
```
POST MANDATEREGISTRATION
{
  pan, mandatestartdate (YYYY-MM-DD), mandateenddate,
  amount: "<max_sip_amount>",
  payervpa: "<user@upi>",
  payername, accountnumber, ifsc,
  RedirectURL: "https://www.kotakmf.com/",
  trxnmode: "UPI_NAC", USER_TYPE: "UPI-POSTLOGIN", intent: "Y"
}
```
Returns: `msgTable[0].cp_mdt_ref_no`

### Step 2 — Poll status (after user approves on phone)
```
POST GETEMANDATESTATUS
{ cp_mandate_ref_no: "<ref_no>" }
```
Returns: `Status: Y` when approved

### Step 3 — Register SIP
Same `SIPTRXN` payload but:
- `payment_mode: "UPI_NAC"`
- `data.payinMech: "UPI_NAC"`
- `data.requestRefno: "<cp_mdt_ref_no>"`

---

## OTM Mandate Registration (NACH via Billdesk — requires bank redirect)

### Step 1 — Insert OTM record
```
POST ADDOTMDETAILS
FLAG: INSERT_OTM, FOLIO_NO, BANK_NAME, AC_NO, IFSC_CODE, MICR_CODE,
AC_TYPE (SB/CA), AMOUNT, FROM_DATE, TO_DATE (DD-MMM-YYYY),
USER_ID, SESSION_ID, SESSION_VALIDATE: Y, TRXN_PAGE: SIP
```
Returns: `OTM_REF_NO`

### Step 2 — Get checksum
```
POST CHECKSUMOTM
{ OTMREQUEST: "<billdesk_pipe_string>", CHECKSUM_KEY: "#NMcolpR3Lke" }
```

### Step 3 — Redirect to Billdesk
```
https://www.billdesk.in/billpay/APIEMandateController?action=APIEMandateRedirectReg&msg=<signed_string>
```
User completes bank authentication there. Callback returns to Kotak.

---

## Other Useful Endpoints

| Endpoint | FLAG | Purpose |
|---|---|---|
| `GETPORTFOLIODETAILS` | `GETPORTFOLIODETAILS` | Folio list after login |
| `GETFOLIOSUMM` | `GETFOLIOSUMM` | Folio value, XIRR, monthly chart |
| `GETADMINSCHEMEDETAILS` | `GETIPSCHEME` | Schemes in a folio |
| `GETSCHEMEDETAILS` | `GETIPSCHDET` | Scheme min/max, units, broker |
| `GETSCHEMESTATUS` | `GETIPSCH_ADMIN` | SIP/STP allowed for scheme |
| `GETSCHEMEDATEDETAILS` | `ALLOWED_DATE` | SIP dates, min installments |
| `GETEXITBANKNAME` | `GETEXITBANKNAME` | Linked bank for autopay |
| `GETOTMDET` | `GET_OTM_DET` | List OTM mandates |
| `INSTREDMEEMFOLIO` | `GETINVESTORDETAILS` | Investor profile |
| `INSTREDMEEMFOLIO` | `GETNOMINEE_DETAILS` | Nominee details |
| `CHECKFATCA` | `GETFPKYCDET` | FATCA/KYC compliance |
| `GETFOLIOSVALIDATE` | `VALIDATEMAPPEDFOLIO` | Validate folio for SIP |
| `fetch/pan/otm/det` | — (REST, body: `{PAN,MOBILE}`) | Check OTM mandate status |
