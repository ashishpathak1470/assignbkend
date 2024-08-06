const express = require("express");
const axios = require("axios");
const xml2js = require("xml2js");
const bodyParser = require("body-parser");
const cors = require("cors");
const cheerio = require("cheerio");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());
app.use(cors());

const fetchSitemap = async (url) => {
  try {
    const response = await axios.get(url);
    const parsedData = await xml2js.parseStringPromise(response.data);
    return parsedData;
  } catch (error) {
    console.error("Error fetching sitemap:", error.message);
    throw new Error("Failed to fetch sitemap");
  }
};

const fetchProductPageContent = async (url) => {
  try {
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);

    const content = $("body")
      .find("p")
      .map((_, el) => $(el).text())
      .get()
      .join(" ");

    return content;
  } catch (error) {
    console.error("Error fetching product page content:", error.message);
    throw new Error("Failed to fetch product page content");
  }
};

const summarizeContent = async (content) => {
  try {
    const maxLength = 2000;
    const truncatedContent = content.slice(0, maxLength);

    const summaryResponse = await axios.post(
      process.env.LLM_API_URL,
      { inputs: truncatedContent },
      {
        headers: {
          Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    let summaryText = summaryResponse.data[0].summary_text.trim();
    if (!summaryText.endsWith(".")) {
      summaryText += ".";
    }

    return summaryText.split("\n").map((bullet) => bullet.trim());
  } catch (error) {
    console.error(
      "Error summarizing content:",
      error.response ? error.response.data : error.message
    );
    throw new Error("Failed to summarize content");
  }
};

const extractSitemapFromRobots = async (domain) => {
  try {
    const robotsUrl = `https://${domain}/robots.txt`;
    const response = await axios.get(robotsUrl);
    const sitemapUrl = response.data.match(/Sitemap:\s*(.*)/i)[1];
    return sitemapUrl;
  } catch (error) {
    console.error("Error extracting sitemap from robots.txt:", error.message);
    throw new Error("Failed to extract sitemap from robots.txt");
  }
};

const findProductSitemap = async (mainSitemapUrl) => {
  try {
    const mainSitemapData = await fetchSitemap(mainSitemapUrl);
    console.log("Main Sitemap Data:", JSON.stringify(mainSitemapData, null, 2));

    if (mainSitemapData.sitemapindex && mainSitemapData.sitemapindex.sitemap) {
      const productSitemap = mainSitemapData.sitemapindex.sitemap.find(
        (item) => item.loc && item.loc[0].includes("products")
      );

      if (!productSitemap) {
        throw new Error("No product sitemap found");
      }

      return productSitemap.loc[0];
    } else if (mainSitemapData.urlset && mainSitemapData.urlset.url) {
      const productSitemapUrl = mainSitemapData.urlset.url.find(
        (item) => item.loc && item.loc[0].includes("products")
      );

      if (!productSitemapUrl) {
        throw new Error("No product sitemap found");
      }

      return productSitemapUrl.loc[0];
    } else {
      throw new Error("Invalid sitemap structure");
    }
  } catch (error) {
    console.error("Error finding product sitemap:", error.message);
    throw new Error("Failed to find product sitemap");
  }
};

app.post('/api/domain-scrape', async (req, res) => {
  const { domain } = req.body;
  try {
    const mainSitemapUrl = await extractSitemapFromRobots(domain);
    const productSitemapUrl = await findProductSitemap(mainSitemapUrl);

    const sitemapData = await fetchSitemap(productSitemapUrl);

    const products = sitemapData.urlset.url.slice(1, 6).map((item) => {
      return {
        link: item.loc ? item.loc[0] : '',
        image: item['image:image'] ? item['image:image'][0]['image:loc'][0] : '',
        title: item['image:image'] ? item['image:image'][0]['image:title'][0] : '',
      };
    });

    console.log('Extracted Products:', products);

    const filteredProducts = products.filter((product) => 
      product.link && product.image && product.title
    );

    const productsWithSummaries = await Promise.all(
      filteredProducts.map(async (product) => {
        try {
          if (!product.link) {
            return { ...product, summary: ['No content available'] };
          }
          
          const pageContent = await fetchProductPageContent(product.link);
          const summary = await summarizeContent(pageContent);
          
          if (!summary || summary.length === 0) {
            return { ...product, summary: ['Failed to summarize content'] };
          }

          return { ...product, summary };
        } catch (error) {
          console.error('Error processing product:', product.link, error.message);
          return { ...product, summary: ['Failed to summarize content'] };
        }
      })
    );

    console.log('Filtered Products with Summaries:', productsWithSummaries);

    res.json(productsWithSummaries);
  } catch (error) {
    console.error('Error in domain scrape:', error.message);
    res.status(500).json({ error: error.message });
  }
});


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
