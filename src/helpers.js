const path = require("path");
const url = require("url");
const fs = require("fs");
const promisify = require("util.promisify");
const color = require("tinycolor2");
const cheerio = require("cheerio");
const colors = require("colors");
const jsonxml = require("jsontoxml");
const sizeOf = require("image-size");
const Jimp = require("jimp");
const svg2png = require("svg2png");
const PLATFORM_OPTIONS = require("./config/platform-options.json");

module.exports = function (options) {
  function directory(path) {
    return path.substr(-1) === "/" ? path : `${path}/`;
  }

  function relative(path) {
    return url.resolve(options.path && directory(options.path), path);
  }

  function log(context, message) {
    if (options.logging) {
      const {
        magenta,
        green,
        yellow
      } = colors;

      message = message.replace(/ \d+(x\d+)?/g, item => magenta(item));
      message = message.replace(/#([0-9a-f]{3}){1,2}/g, item => magenta(item));
      console.log(`${green("[Favicons]")} ${yellow(context)}: ${message}...`);
    }
  }

  function parseColor(hex) {
    const {
      r,
      g,
      b,
      a
    } = color(hex).toRgb();

    return Jimp.rgbaToInt(r, g, b, a * 255);
  }

  return {
    General: {
      source(src) {
        log("General:source", `Source type is ${typeof src}`);

        if (Buffer.isBuffer(src)) {
          try {
            return Promise.resolve([{
              size: sizeOf(src),
              file: src
            }]);
          } catch (error) {
            return Promise.reject(new Error("Invalid image buffer"));
          }
        } else if (typeof src === "string") {
          return promisify(fs.readFile)(src).then(this.source.bind(this));
        } else if (Array.isArray(src) && !src.some(Array.isArray)) {
          if (!src.length) {
            return Promise.reject(new Error("No source provided"));
          }

          return Promise.all(src.map(this.source.bind(this))).then(results => [].concat(...results));
        } else {
          return Promise.reject(new Error("Invalid source type provided"));
        }
      },

      preparePlatformOptions(platform) {
        const parameters =
          typeof options.icons[platform] === "object" ?
          options.icons[platform] : {};

        for (const key of Object.keys(parameters)) {
          if (!(key in PLATFORM_OPTIONS) ||
            !PLATFORM_OPTIONS[key].platforms.includes(platform)
          ) {
            throw new Error(
              `Unsupported option '${key}' on platform '${platform}'`
            );
          }
        }

        for (const key of Object.keys(PLATFORM_OPTIONS)) {
          const {
            platforms,
            defaultTo
          } = PLATFORM_OPTIONS[key];

          if (!(key in parameters) && platforms.includes(platform)) {
            parameters[key] = defaultTo;
          }
        }

        if (typeof parameters.background === "boolean") {
          if (platform === "android" && !parameters.background) {
            parameters.background = "transparent";
          } else {
            parameters.background = options.background;
          }
        }

        if (platform === "android" && parameters.background !== "transparent") {
          parameters.disableTransparency = true;
        }

        return parameters;
      }
    },

    HTML: {
      parse(html) {
        return new Promise(resolve => {
          log("HTML:parse", "HTML found, parsing and modifying source");
          const $ = cheerio.load(html),
            link = $("*").is("link"),
            attribute = link ? "href" : "content",
            value = $("*")
            .first()
            .attr(attribute);

          if (path.extname(value)) {
            $("*")
              .first()
              .attr(attribute, relative(value));
          } else if (value.slice(0, 1) === "#") {
            $("*")
              .first()
              .attr(attribute, options.background);
          } else if (
            html.includes("application-name") ||
            html.includes("apple-mobile-web-app-title")
          ) {
            $("*")
              .first()
              .attr(attribute, options.appName);
          }
          return resolve($.html());
        });
      }
    },

    Files: {
      create(properties, name) {
        return new Promise(resolve => {
          log("Files:create", `Creating file: ${name}`);
          if (name === "manifest.json") {
            properties.name = options.appName;
            properties.short_name = options.shortName || options.appName;
            properties.description = options.appDescription;
            properties.dir = options.dir;
            properties.lang = options.lang;
            properties.display = options.display;
            properties.orientation = options.orientation;
            properties.start_url = options.start_url;
            properties.background_color = options.background;
            properties.theme_color = options.theme_color;
            properties.icons.map(icon => (icon.src = relative(icon.src)));
            properties = JSON.stringify(properties, null, 2);
          } else if (name === "manifest.webapp") {
            properties.version = options.version;
            properties.name = options.appName;
            properties.description = options.appDescription;
            properties.developer.name = options.developerName;
            properties.developer.url = options.developerURL;
            properties.icons = Object.keys(properties.icons).reduce(
              (obj, key) =>
              Object.assign(obj, {
                [key]: relative(properties.icons[key])
              }), {}
            );
            properties = JSON.stringify(properties, null, 2);
          } else if (name === "browserconfig.xml") {
            properties[0].children[0].children[0].children.map(property => {
              if (property.name === "TileColor") {
                property.text = options.background;
              } else {
                property.attrs.src = relative(property.attrs.src);
              }
            });
            properties = jsonxml(properties, {
              prettyPrint: true,
              xmlHeader: true,
              indent: "  "
            });
          } else if (name === "yandex-browser-manifest.json") {
            properties.version = options.version;
            properties.api_version = 1;
            properties.layout.logo = relative(properties.layout.logo);
            properties.layout.color = options.background;
            properties = JSON.stringify(properties, null, 2);
          } else if (/\.html$/.test(name)) {
            properties = properties.join("\n");
          }
          return resolve({
            name,
            contents: properties
          });
        });
      }
    },

    Images: {
      create(properties, background) {
        return new Promise((resolve, reject) => {
          log(
            "Image:create",
            `Creating empty ${properties.width}x${
              properties.height
            } canvas with ${
              properties.transparent ? "transparent" : background
            } background`
          );

          this.jimp = new Jimp(
            properties.width,
            properties.height,
            properties.transparent ? 0 : parseColor(background),
            (error, canvas) => (error ? reject(error) : resolve(canvas))
          );
        });
      },

      render(sourceset, properties, offset) {
        log(
          "Image:render",
          `Find nearest icon to ${properties.width}x${
            properties.height
          } with offset ${offset}`
        );

        const width = properties.width - offset * 2;
        const height = properties.height - offset * 2;
        const svgSource = sourceset.find(source => source.size.type === "svg");

        let promise = null;

        if (svgSource) {
          log("Image:render", `Rendering SVG to ${width}x${height}`);
          promise = svg2png(svgSource.file, {
            height,
            width
          }).then(Jimp.read);
        } else {
          const sideSize = Math.max(width, height);

          let nearestIcon = sourceset[0];
          let nearestSideSize = Math.max(
            nearestIcon.size.width,
            nearestIcon.size.height
          );

          for (const icon of sourceset) {
            const max = Math.max(icon.size.width, icon.size.height);

            if (
              (nearestSideSize > max || nearestSideSize < sideSize) &&
              max >= sideSize
            ) {
              nearestIcon = icon;
              nearestSideSize = max;
            }
          }

          log("Images:render", `Resizing PNG to ${width}x${height}`);

          promise = Jimp.read(nearestIcon.file).then(image =>
            image.contain(
              width,
              height,
              Jimp.HORIZONTAL_ALIGN_CENTER | Jimp.VERTICAL_ALIGN_MIDDLE
            )
          );
        }

        return promise.then(image => {
          if (properties.rotate) {
            const degrees = 90;

            log("Images:render", `Rotating image by ${degrees}`);
            image.rotate(degrees, false);
          }

          return image;
        });
      },

      mask: Jimp.read(path.join(__dirname, "mask.png")),
      overlay: Jimp.read(path.join(__dirname, "overlay.png")),

      composite(canvas, image, properties, offset, max) {
        if (properties.mask) {
          log("Images:composite", "Masking composite image on circle");
          return Promise.all([this.mask, this.overlay]).then(
            ([mask, overlay]) => {
              canvas.mask(mask.clone().resize(max, Jimp.AUTO), 0, 0);
              canvas.composite(overlay.clone().resize(max, Jimp.AUTO), 0, 0);
              properties = Object.assign({}, properties, {
                mask: false
              });

              return this.composite(canvas, image, properties, offset, max);
            }
          );
        }

        log(
          "Images:composite",
          `Compositing favicon on ${properties.width}x${
            properties.height
          } canvas with offset ${offset}`
        );

        return new Promise((resolve, reject) =>
          canvas
          .composite(image, offset, offset)
          .getBuffer(
            Jimp.MIME_PNG,
            (error, result) => (error ? reject(error) : resolve(result))
          )
        );
      }
    }
  };
};
