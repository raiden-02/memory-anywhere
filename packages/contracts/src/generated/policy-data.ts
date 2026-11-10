// Generated from packages/server/policy/ by `pnpm gen`. Do not edit.

export interface SecretRule {
  readonly type: string;
  readonly pattern: string;
  readonly flags?: "i";
  readonly check?: "luhn" | "mod97";
  readonly near?: { readonly pattern: string; readonly flags?: "i"; readonly window: number };
}

export const SECRET_RULES: readonly SecretRule[] = [
  {
    "type": "aws_access_key",
    "pattern": "(?:AKIA|ASIA)[0-9A-Z]{16}"
  },
  {
    "type": "aws_secret",
    "pattern": "[A-Za-z0-9/+=]{40}",
    "near": {
      "pattern": "aws",
      "flags": "i",
      "window": 40
    }
  },
  {
    "type": "github_token",
    "pattern": "gh[pousr]_[A-Za-z0-9]{36,}"
  },
  {
    "type": "github_token",
    "pattern": "github_pat_[A-Za-z0-9_]{80,}"
  },
  {
    "type": "slack_token",
    "pattern": "xox[abprs]-[A-Za-z0-9-]{10,}"
  },
  {
    "type": "anthropic_key",
    "pattern": "sk-ant-[A-Za-z0-9_-]{20,}"
  },
  {
    "type": "openai_key",
    "pattern": "sk-[A-Za-z0-9_-]{20,}"
  },
  {
    "type": "google_api_key",
    "pattern": "AIza[0-9A-Za-z_-]{35}"
  },
  {
    "type": "stripe_key",
    "pattern": "(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{24,}"
  },
  {
    "type": "private_key",
    "pattern": "-----BEGIN [A-Z ]*PRIVATE KEY-----"
  },
  {
    "type": "jwt",
    "pattern": "eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}"
  },
  {
    "type": "payment_card",
    "pattern": "\\b\\d(?:[ -]?\\d){12,18}\\b",
    "check": "luhn"
  },
  {
    "type": "iban",
    "pattern": "\\b[A-Z]{2}\\d{2}[A-Z0-9]{11,30}\\b",
    "check": "mod97"
  },
  {
    "type": "us_ssn",
    "pattern": "\\b\\d{3}-\\d{2}-\\d{4}\\b"
  },
  {
    "type": "aadhaar",
    "pattern": "\\b\\d{4}\\s\\d{4}\\s\\d{4}\\b"
  },
  {
    "type": "passport",
    "pattern": "passport (?:no|number)[: ]+[A-Z0-9]{6,9}",
    "flags": "i"
  },
  {
    "type": "password",
    "pattern": "(?:password|passcode|pin|passphrase)\\s*(?:is|=|:)\\s*\\S+",
    "flags": "i"
  }
];

export const STOPWORDS: readonly string[] = ["i","me","my","myself","we","our","ours","ourselves","you","you're","you've","you'll","you'd","your","yours","yourself","yourselves","he","him","his","himself","she","she's","her","hers","herself","it","it's","its","itself","they","them","their","theirs","themselves","what","which","who","whom","this","that","that'll","these","those","am","is","are","was","were","be","been","being","have","has","had","having","do","does","did","doing","a","an","the","and","but","if","or","because","as","until","while","of","at","by","for","with","about","against","between","into","through","during","before","after","above","below","to","from","up","down","in","out","on","off","over","under","again","further","then","once","here","there","when","where","why","how","all","any","both","each","few","more","most","other","some","such","no","nor","not","only","own","same","so","than","too","very","s","t","can","will","just","don","don't","should","should've","now","d","ll","m","o","re","ve","y","ain","aren","aren't","couldn","couldn't","didn","didn't","doesn","doesn't","hadn","hadn't","hasn","hasn't","haven","haven't","isn","isn't","ma","mightn","mightn't","mustn","mustn't","needn","needn't","shan","shan't","shouldn","shouldn't","wasn","wasn't","weren","weren't","won","won't","wouldn","wouldn't"];
