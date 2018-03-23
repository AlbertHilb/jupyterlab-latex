// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  PromiseDelegate
} from '@phosphor/coreutils';

import {
  ElementExt
} from '@phosphor/domutils';

import {
  Message
} from '@phosphor/messaging';

import {
  Widget, PanelLayout
} from '@phosphor/widgets';

import {
  Toolbar, ToolbarButton
} from '@jupyterlab/apputils';

import {
  PathExt
} from '@jupyterlab/coreutils';

import {
  ISignal,
  Signal
} from '@phosphor/signaling';

import {
  ABCWidgetFactory, DocumentRegistry
} from '@jupyterlab/docregistry';

import 'pdfjs-dist/webpack';
import 'pdfjs-dist/web/pdf_viewer';

import '../style/index.css';
import 'pdfjs-dist/web/pdf_viewer.css';


/**
 * The MIME type for PDF.
 */
export
const MIME_TYPE = 'application/pdf';

/**
 * The CSS class for the viewer defined by PDFJS.
 */
export
const PDF_CLASS = 'pdfViewer';

/**
 * The CSS class for our PDF container.
 */
export
const PDF_CONTAINER_CLASS = 'jp-PDFJSContainer';

/**
 * A boolean indicating whether the platform is Mac.
 */
const IS_MAC = !!navigator.platform.match(/Mac/i);

/**
 * The step in scaling factors for zooming the PDF viewer.
 */
export
const SCALE_DELTA = 1.1;

/**
 * The maximum scaling factor for zooming the PDF viewer.
 */
export
const MAX_SCALE = 10.0;

/**
 * The minimum scaling factor for zooming the PDF viewer.
 */
export
const MIN_SCALE = 0.25;


/**
 * PDFJS adds a global object to the page called `PDFJS`.
 * Declare a reference to that.
 */
declare const PDFJS: any;

/**
 * A class for rendering a PDF document.
 */
export
class PDFJSViewer extends Widget implements DocumentRegistry.IReadyWidget {
  constructor(context: DocumentRegistry.Context) {
    super();

    const layout = this.layout = new PanelLayout();
    this._viewer = new Widget({ node: Private.createNode() });
    this._pdfViewer = new PDFJS.PDFViewer({ container: this._viewer.node });
    this._toolbar = Private.createToolbar(this._pdfViewer);

    layout.addWidget(this._toolbar);
    layout.addWidget(this._viewer);

    this.context = context;
    this._onTitleChanged();
    context.pathChanged.connect(this._onTitleChanged, this);

    context.ready.then(() => {
      if (this.isDisposed) {
        return;
      }
      this._render().then(() => {
        this._ready.resolve(void 0);
      });
      context.model.contentChanged.connect(this.update, this);
      context.fileChanged.connect(this.update, this);
    });
  }

  /**
   * The pdfjs widget's context.
   */
  readonly context: DocumentRegistry.Context;

  /**
   * A promise that resolves when the pdf viewer is ready.
   */
  get ready(): Promise<void> {
    return this._ready.promise;
  }

  /**
   * Get the scroll position.
   */
  get position(): PDFJSViewer.IPosition {
    return {
      page: this._pdfViewer.currentPageNumber,
      x: 0,
      y: 0
    };
  }

  /**
   * Set the scroll position.
   */
  set position(pos: PDFJSViewer.IPosition) {
    // Clamp the page number.
    const pageNumber = Math.max(
      Math.min(pos.page, this._pdfViewer.pagesCount + 1), 1);
    // Scroll page into view using a very undocumented
    // set of options.
    this._pdfViewer.scrollPageIntoView({
      pageNumber,
      destArray: [
        pageNumber,
        { name: 'XYZ' },
        pos.x,
        pos.y,
        this._pdfViewer.currentScaleValue
      ]
    });
  }

  /**
   * Dispose of the resources held by the pdf widget.
   */
  dispose() {
    try {
      URL.revokeObjectURL(this._objectUrl);
    } catch (error) { /* no-op */ }
    super.dispose();
  }

  get positionRequested(): ISignal<this, PDFJSViewer.IPosition> {
    return this._positionRequested;
  }

  /**
   * Handle a change to the title.
   */
  private _onTitleChanged(): void {
    this.title.label = PathExt.basename(this.context.localPath);
  }

  /**
   * Render PDF into this widget's node.
   */
  private _render(): Promise<void> {
    return new Promise<void>(resolve => {
      let data = this.context.model.toString();
      // If there is no data, do nothing.
      if (!data) {
        resolve (void 0);
      }
      const blob = Private.b64toBlob(data, MIME_TYPE);

      let oldDocument = this._pdfDocument;
      let oldUrl = this._objectUrl;
      this._objectUrl = URL.createObjectURL(blob);

      let scale: number | string = 'page-width';
      let scrollTop = 0;

      // Try to keep the scale and scroll position.
      if (this._hasRendered && this.isVisible) {
        scale = this._pdfViewer.currentScaleValue || scale;
        scrollTop = this._viewer.node.scrollTop;
      }

      const cleanup = () => {
        // Release reference to any previous document.
        if (oldDocument) {
          oldDocument.destroy();
        }
        // Release reference to any previous object url.
        if (oldUrl) {
          try {
            URL.revokeObjectURL(oldUrl);
          } catch (error) { /* no-op */ }
        }
      };

      PDFJS.getDocument(this._objectUrl).then((pdfDocument: any) => {
        this._pdfDocument = pdfDocument;
        this._pdfViewer.setDocument(pdfDocument);
        this._pdfViewer.firstPagePromise.then(() => {
          if (this.isVisible) {
            this._pdfViewer.currentScaleValue = scale;
          }
          this._hasRendered = true;
          resolve(void 0);
        });
        this._pdfViewer.pagesPromise.then(() => {
          if (this.isVisible) {
            this._viewer.node.scrollTop = scrollTop;
          }
          cleanup();
        });
      }).catch(cleanup);
    });
  }

  /**
   * Handle DOM events for the widget.
   */
  handleEvent(event: Event): void {
    if (!this._pdfViewer) {
      return;
    }
    switch (event.type) {
      case 'click':
        this._handleClick(event as MouseEvent);
        break;
      default:
        break;
    }
  }

  private _handleClick(evt: MouseEvent): void {
    // If it is a normal click, return without doing anything.
    const shiftAccel = (evt: MouseEvent): boolean => {
      return evt.shiftKey ?
        IS_MAC && evt.metaKey || !IS_MAC && evt.ctrlKey :
        false;
    };
    if (!shiftAccel(evt)) {
      return;
    }

    // Get the page position of the click.
    const pos = this._clientToPDFPosition(evt.clientX, evt.clientY);

    // If the click was not on a page, do nothing.
    if (!pos) {
      return;
    }
    // Emit the `positionRequested` signal.
    this._positionRequested.emit(pos);
  }

  private _clientToPDFPosition(x: number, y: number): PDFJSViewer.IPosition | undefined {
    let page: any;
    let pageNumber = 0;
    for (; pageNumber < this._pdfViewer.pagesCount; pageNumber++) {
      const pageView = this._pdfViewer.getPageView(pageNumber);
      // If the page is not rendered (as happens when it is
      // scrolled out of view), then the textLayer div doesn't
      // exist, and we can safely skip it.
      if (!pageView.textLayer) {
        continue;
      }
      const pageDiv = pageView.textLayer.textLayerDiv;
      if (ElementExt.hitTest(pageDiv, x, y)) {
        page = pageView;
        break;
      }
    }
    if (!page) {
      return;
    }
    const pageDiv = page.textLayer.textLayerDiv;
    const boundingRect = pageDiv.getBoundingClientRect();
    const localX = x - boundingRect.left;
    const localY = y - boundingRect.top;
    const viewport = page.viewport.clone({dontFlip: true});
    const [pdfX, pdfY] = viewport.convertToPdfPoint(localX, localY);
    return {
      page: pageNumber + 1,
      x: pdfX,
      y: pdfY
    } as PDFJSViewer.IPosition;
  }

  /**
   * Handle `after-attach` messages for the widget.
   */
  protected onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    this._viewer.node.addEventListener('click', this);
  }

  /**
   * Handle `before-detach` messages for the widget.
   */
  protected onBeforeDetach(msg: Message): void {
    let node = this._viewer.node;
    node.removeEventListener('click', this);
  }

  /**
   * Fit the PDF to the widget width.
   */
  fit(): void {
    if (this.isVisible) {
      this._pdfViewer.currentScaleValue = 'page-width';
    }
  }

  /**
   * Handle `update-request` messages for the widget.
   */
  protected onUpdateRequest(msg: Message): void {
    if (this.isDisposed || !this.context.isReady) {
      return;
    }
    this._render();
  }



  private _ready = new PromiseDelegate<void>();
  private _objectUrl = '';
  private _pdfViewer: any;
  private _pdfDocument: any;
  private _positionRequested = new Signal<this, PDFJSViewer.IPosition>(this);
  private _viewer: Widget;
  private _toolbar: Toolbar<Widget>;
  private _hasRendered = false;
}

/**
 * A widget factory for images.
 */
export
class PDFJSViewerFactory extends ABCWidgetFactory<PDFJSViewer, DocumentRegistry.IModel> {
  /**
   * Create a new widget given a context.
   */
  protected createNewWidget(context: DocumentRegistry.IContext<DocumentRegistry.IModel>): PDFJSViewer {
    return new PDFJSViewer(context);
  }
}

/**
 * A namespace for PDFJSViewer statics.
 */
export
namespace PDFJSViewer {
  /**
   * The options for a SyncTeX edit command,
   * mapping the pdf position to an editor position.
   */
  export
  interface IPosition {
    /**
     * The page of the pdf.
     */
    page: number;

    /**
     * The x-position on the page, in pts, where
     * the PDF is assumed to be 72dpi.
     */
    x: number;

    /**
     * The y-position on the page, in pts, where
     * the PDF is assumed to be 72dpi.
     */
    y: number;
  }
}

/**
 * A namespace for PDF widget private data.
 */
namespace Private {
  /**
   * Create the node for the PDF widget.
   */
  export
  function createNode(): HTMLElement {
    let node = document.createElement('div');
    node.className = PDF_CONTAINER_CLASS;
    let pdf = document.createElement('div');
    pdf.className = PDF_CLASS;
    node.appendChild(pdf);
    node.tabIndex = -1;
    return node;
  }

  /**
   * Create the toolbar for the PDF viewer.
   */
  export
  function createToolbar(pdfViewer: any): Toolbar<ToolbarButton> {
    const toolbar = new Toolbar();

    toolbar.addClass('jp-Toolbar');
    toolbar.addClass('jp-PDFJS-toolbar');

    toolbar.addItem('previous', new ToolbarButton({
      className: 'jp-PreviousIcon',
      onClick: () => {
        pdfViewer.currentPageNumber =
          Math.max(pdfViewer.currentPageNumber - 1, 1);
      },
      tooltip: 'Previous Page'
    }));
    toolbar.addItem('next', new ToolbarButton({
      className: 'jp-NextIcon',
      onClick: () => {
        pdfViewer.currentPageNumber =
          Math.min(pdfViewer.currentPageNumber + 1, pdfViewer.pagesCount);
      },
      tooltip: 'Next Page'
    }));

    toolbar.addItem('spacer', Toolbar.createSpacerItem());

    toolbar.addItem('zoomOut', new ToolbarButton({
      className: 'jp-ZoomOutIcon',
      onClick: () => {
        let newScale = pdfViewer.currentScale;

        newScale = (newScale / SCALE_DELTA).toFixed(2);
        newScale = Math.floor(newScale * 10) / 10;
        newScale = Math.max(MIN_SCALE, newScale);

        pdfViewer.currentScale = newScale;
      },
      tooltip: 'Zoom Out'
    }));
    toolbar.addItem('zoomIn', new ToolbarButton({
      className: 'jp-ZoomInIcon',
      onClick: () => {
        let newScale = pdfViewer.currentScale;

        newScale = (newScale * SCALE_DELTA).toFixed(2);
        newScale = Math.ceil(newScale * 10) / 10;
        newScale = Math.min(MAX_SCALE, newScale);

        pdfViewer.currentScale = newScale;
      },
      tooltip: 'Zoom In'
    }));

    return toolbar;
  }

  /**
   * Convert a base64 encoded string to a Blob object.
   * Modified from a snippet found here:
   * https://stackoverflow.com/questions/16245767/creating-a-blob-from-a-base64-string-in-javascript
   *
   * @param b64Data - The base64 encoded data.
   *
   * @param contentType - The mime type of the data.
   *
   * @param sliceSize - The size to chunk the data into for processing.
   *
   * @returns a Blob for the data.
   */
  export
  function b64toBlob(b64Data: string, contentType: string = '', sliceSize: number = 512): Blob {
    const byteCharacters = atob(b64Data);
    let byteArrays: Uint8Array[] = [];

    for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
      let slice = byteCharacters.slice(offset, offset + sliceSize);

      let byteNumbers = new Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i);
      }
      let byteArray = new Uint8Array(byteNumbers);
      byteArrays.push(byteArray);
    }

    let blob = new Blob(byteArrays, {type: contentType});
    return blob;
  }
}
