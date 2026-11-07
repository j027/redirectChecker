import { describe, it, expect } from "vitest";
// hunterService must load first: the hunter modules import each other.
import "../../src/services/hunterService.js";
import {
  extractTaboolaCreative,
  findTaboolaCloakerCandidate,
  findWhitelistedBidTarget,
  parseTaboolaAuctionResponse,
  parseTaboolaRecommendationsResponse,
  parseTaboolaRequestContext,
  resolveTaboolaDestination,
  taboolaCreativeKey,
} from "../../src/services/taboolaHunter.js";
import type { TaboolaBid } from "../../src/services/taboolaHunter.js";

const CRITEO_CLICK =
  "https://cat.da1.us.criteo.com/delivery/ckn.php?cppv=3&cpp=abc" +
  "&maxdest=https%3A%2F%2Fretailer.example%2Fproduct%2F123" +
  "%3Futm_source%3Dcriteo%26utm_medium%3Ddisplay&tblci=TOKEN#tblciTOKEN";

const DOUBLECLICK_CLICK =
  "https://pn.ybp.yahoo.com/cj/cd/TOKEN/rurl/" +
  "https://ad.doubleclick.net/ddm/trackclk/N123/B456;dc_trk_aid=1;dc_tdv=1" +
  "?tblci=ABC#tblciABC";

function buildAdm(rec: Record<string, unknown>): string {
  return `<html><head></head><body>
<script>
window._taboola = window._taboola || [];
_taboola.push({ mode: 'Viper_300x250_1x1_White', container: 'taboola-below-article-thumbnails', rec: ${JSON.stringify(rec)} });
</script>
<div style="display:none;"><img src="https://api-taboola.com/notify-win-nurl?x=1" alt=""></div>
</body></html>`;
}

function creativeRec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trc: { si: "session", ui: "user" },
    vl: [
      {
        ri: "bid-id",
        description: "Example ad description &amp; more",
        title: "Example ad title",
        "branding-text": "Example Brand",
        adomain: "advertiser.example",
        "cta-text": "Learn More",
        thumbnail: "https://cdn.example/thumb.jpeg",
        "item-id": "item-id",
        url: DOUBLECLICK_CLICK,
        ...overrides,
      },
    ],
  };
}

const AUCTION_RESPONSE = {
  id: "auction-id",
  seatbid: [
    {
      seat: "rtb",
      bid: [
        {
          id: "bid-a",
          impid: "imp-a",
          price: 0.4503,
          adid: "1001",
          adm: buildAdm(creativeRec()),
          adomain: ["advertiser.example"],
          cid: "2001",
          crid: "1001",
          w: 300,
          h: 250,
          nurl: "https://api.taboola.com/notify-win-nurl?secret=1",
          burl: "https://api.taboola.com/notify-billing-burl?secret=1",
          lurl: "https://api.taboola.com/notify-lost?secret=1",
        },
        {
          id: "bid-b",
          impid: "imp-b",
          price: 0.5099,
          adid: "1002",
          adm: buildAdm(creativeRec({ url: DOUBLECLICK_CLICK })),
          adomain: ["advertiser.example"],
          cid: "2001",
          crid: "1002",
          w: 300,
          h: 250,
        },
        {
          id: "bid-c",
          impid: "imp-c",
          price: 0.8102,
          adid: "1003",
          adm: buildAdm(
            creativeRec({
              url: CRITEO_CLICK,
              title: "Example Cat Food",
              description: "Example pet food",
              "branding-text": "$28.59 - Example Retailer",
              adomain: "retailer.example",
              thumbnail: "https://cdn.example/thumb.jpeg",
            })
          ),
          adomain: ["retailer.example"],
          cid: "2002",
          crid: "1003",
          w: 300,
          h: 600,
        },
      ],
    },
  ],
  cur: "USD",
};

const REQUEST_CONTEXT = parseTaboolaRequestContext(
  JSON.stringify({
    imp: [
      {
        id: "imp-a",
        tagid: "Yahoo Mail - ROS - Desktop - Top_Right_A",
        bidfloor: 3.962,
        gpid: "us_ymail_ros_dt_as_top_right_a",
      },
      {
        id: "imp-b",
        tagid: "Yahoo Mail - ROS - Desktop - Top_Right_B",
        bidfloor: 3.662,
        gpid: "us_ymail_ros_dt_as_top_right_b",
      },
      {
        id: "imp-c",
        tagid: "Yahoo Mail - ROS - Desktop - Top_Right_C",
        bidfloor: 2.206,
        gpid: "us_ymail_ros_dt_as_top_right_c",
      },
    ],
  })
);

describe("parseTaboolaAuctionResponse", () => {
  it("flattens all bids in a response", () => {
    const bids = parseTaboolaAuctionResponse(AUCTION_RESPONSE, REQUEST_CONTEXT);
    expect(bids).toHaveLength(3);
    expect(bids.map((bid) => bid.bidId)).toEqual(["bid-a", "bid-b", "bid-c"]);
  });

  it("maps impid back to tagid and bidfloor", () => {
    const bids = parseTaboolaAuctionResponse(AUCTION_RESPONSE, REQUEST_CONTEXT);
    expect(bids[0].placement).toBe(
      "Yahoo Mail - ROS - Desktop - Top_Right_A"
    );
    expect(bids[0].bidfloor).toBe(3.962);
    expect(bids[2].placement).toBe(
      "Yahoo Mail - ROS - Desktop - Top_Right_C"
    );
  });

  it("unwraps the Yahoo click wrapper and marks it as click-required", () => {
    const bids = parseTaboolaAuctionResponse(AUCTION_RESPONSE, REQUEST_CONTEXT);
    expect(bids[0].destination).toEqual({
      url:
        "https://ad.doubleclick.net/ddm/trackclk/N123/B456;dc_trk_aid=1;dc_tdv=1" +
        "?tblci=ABC#tblciABC",
      source: "unwrapped_click",
      requiresClick: true,
    });
  });

  it("extracts the Criteo maxdest landing URL without a click", () => {
    const bids = parseTaboolaAuctionResponse(AUCTION_RESPONSE, REQUEST_CONTEXT);
    expect(bids[2].destination).toEqual({
      url: "https://retailer.example/product/123?utm_source=criteo&utm_medium=display",
      source: "maxdest",
      requiresClick: false,
    });
  });

  it("ignores nurl, burl, and the hidden win-notice image", () => {
    const bids = parseTaboolaAuctionResponse(AUCTION_RESPONSE, REQUEST_CONTEXT);
    for (const bid of bids) {
      expect(bid.destination?.url).not.toContain("notify-win-nurl");
      expect(bid.destination?.url).not.toContain("notify-billing-burl");
      expect(bid.destination?.url).not.toContain("notify-lost");
    }
  });

  it("returns an empty list for no-bid and malformed responses", () => {
    expect(parseTaboolaAuctionResponse(null)).toEqual([]);
    expect(parseTaboolaAuctionResponse({})).toEqual([]);
    expect(parseTaboolaAuctionResponse({ seatbid: [] })).toEqual([]);
    expect(
      parseTaboolaAuctionResponse({ seatbid: [{ bid: [{}] }] })
    ).toEqual([]);
  });
});

describe("extractTaboolaCreative", () => {
  it("extracts and decodes HTML entities in display fields", () => {
    const creative = extractTaboolaCreative(buildAdm(creativeRec()));
    expect(creative?.title).toBe("Example ad title");
    expect(creative?.description).toBe(
      "Example ad description & more"
    );
    expect(creative?.advertiserDomain).toBe("advertiser.example");
    expect(creative?.clickUrl).toBe(DOUBLECLICK_CLICK);
  });

  it("returns null when rec.vl has no usable URL", () => {
    expect(
      extractTaboolaCreative(buildAdm({ vl: [{ title: "No URL" }] }))
    ).toBeNull();
  });
});

describe("resolveTaboolaDestination", () => {
  it("treats a non-tracker URL as a direct destination", () => {
    expect(resolveTaboolaDestination("https://example.com/landing")).toEqual({
      url: "https://example.com/landing",
      source: "raw",
      requiresClick: false,
    });
  });

  it("marks a redir that points at a click tracker as click-required", () => {
    const href =
      "https://api.taboola.com/2.0/json/yahoo-mail/recommendations.notify-click" +
      "?redir=https%3A%2F%2Fad.doubleclick.net%2Fddm%2Ftrackclk%2FN123";

    expect(resolveTaboolaDestination(href)).toEqual({
      url: "https://ad.doubleclick.net/ddm/trackclk/N123",
      source: "redir",
      requiresClick: true,
    });
  });

  it("returns null for a malformed URL", () => {
    expect(resolveTaboolaDestination("not a url")).toBeNull();
  });
});

describe("parseTaboolaRecommendationsResponse", () => {
  const nativeResponse = {
    placements: [
      {
        id: "placement-id",
        name: "example.com_P000000_S000000_T000000_MIP0_TB",
        list: [
          {
            type: "TEXT",
            name: "Meet someone new",
            branding: "example-brand",
            "cta-text": "Learn More",
            id: "~~V1~~3001~~long-token",
            tblci: "tblci-token",
            thumbnail: [
              {
                url: "https://cdn.example/thumb.jpeg",
                width: 180,
                height: 180,
              },
            ],
            url:
              "https://api.taboola.com/2.0/json/yahoo-mail/recommendations.notify-click" +
              "?app.type=web&redir=https%3A%2F%2Flanding.example%2Fcl%3Fm315%3Dc%26q%3Dabc",
          },
        ],
      },
    ],
  };

  it("parses native inbox items and extracts the redir destination", () => {
    const bids = parseTaboolaRecommendationsResponse(nativeResponse);
    expect(bids).toHaveLength(1);
    expect(bids[0].creativeId).toBe("3001");
    expect(bids[0].placement).toBe(
      "example.com_P000000_S000000_T000000_MIP0_TB"
    );
    expect(bids[0].creative?.brandingText).toBe("example-brand");
    expect(bids[0].destination).toEqual({
      url: "https://landing.example/cl?m315=c",
      source: "redir",
      requiresClick: false,
    });
  });

  it("returns an empty list for malformed native responses", () => {
    expect(parseTaboolaRecommendationsResponse(null)).toEqual([]);
    expect(parseTaboolaRecommendationsResponse({})).toEqual([]);
    expect(parseTaboolaRecommendationsResponse({ placements: [] })).toEqual([]);
  });
});

describe("taboolaCreativeKey", () => {
  it("combines advertiser, campaign, and creative IDs", () => {
    const bids = parseTaboolaAuctionResponse(AUCTION_RESPONSE, REQUEST_CONTEXT);
    expect(taboolaCreativeKey(bids[2])).toBe(
      "retailer.example|2002|1003"
    );
  });
});

describe("findTaboolaCloakerCandidate", () => {
  it("skips Yahoo, DoubleClick, and Criteo hops", () => {
    expect(
      findTaboolaCloakerCandidate(
        [
          "https://pn.ybp.yahoo.com/cj/cd/token/rurl/https://ad.doubleclick.net/x",
          "https://ad.doubleclick.net/ddm/trackclk/N123",
          "https://scam.example/landing",
        ],
        "https://scam.example/landing"
      )
    ).toBeNull();
  });

  it("returns the last non-infrastructure hop", () => {
    expect(
      findTaboolaCloakerCandidate(
        [
          "https://pn.ybp.yahoo.com/cj/cd/token/rurl/https://ad.doubleclick.net/x",
          "https://ad.doubleclick.net/ddm/trackclk/N123",
          "https://cloaker.example/redirect",
          "https://scam.example/landing",
        ],
        "https://scam.example/landing"
      )
    ).toBe("https://cloaker.example/redirect");
  });
});

describe("findWhitelistedBidTarget", () => {
  function bid(
    destinationUrl: string,
    advertiserDomains: string[]
  ): TaboolaBid {
    return {
      bidId: "bid-id",
      impressionId: "imp-id",
      price: 0,
      advertiserDomains,
      creative: null,
      destination: {
        url: destinationUrl,
        source: "raw",
        requiresClick: false,
      },
    };
  }

  const isNortonWhitelisted = (url: string): boolean => {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return hostname === "norton.com" || hostname.endsWith(".norton.com");
    } catch {
      return false;
    }
  };

  it("matches a whitelisted direct destination", () => {
    expect(
      findWhitelistedBidTarget(
        bid("https://lifelock.norton.com/products", []),
        isNortonWhitelisted
      )
    ).toBe("https://lifelock.norton.com/products");
  });

  it("matches a whitelisted advertiser behind a tracker URL", () => {
    expect(
      findWhitelistedBidTarget(
        bid("https://ad.doubleclick.net/ddm/trackclk/N123", [
          "lifelock.norton.com",
        ]),
        isNortonWhitelisted
      )
    ).toBe("lifelock.norton.com");
  });

  it("does not skip an unrelated bid", () => {
    expect(
      findWhitelistedBidTarget(
        bid("https://ad.doubleclick.net/ddm/trackclk/N123", [
          "unrelated.example",
        ]),
        isNortonWhitelisted
      )
    ).toBeNull();
  });
});
