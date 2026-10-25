"use strict";!function(document,Drupal,$){"use strict";/**
   * Handle anchors paragraph
   */Drupal.behaviors.paragraphInfoTraffic={attach:function attach(context,settings){/**
       * Updates the disruptions container with the list of all disruptions
       * @param {object} $disruptionsContainer the disruptions container
       * @param {string} disruptions Disruptions html
       * @returns {void}
       */function updateDisruptionsContainer($disruptionsContainer,disruptions){$disruptionsContainer.html(disruptions);// eslint-disable-next-line max-len
var $trafficLineNumber=$(once("trafficLineNumber",".js-traffic-line-number",$disruptionsContainer.get(0)));$trafficLineNumber.each(function(){// eslint-disable-next-line max-len
$(this).attr("style",String("background-color: "+$(this).data("color")));});}/**
       * Fetch Traffic Disruptions.
       * @param {object} $disruptionsContainer Disruptions paragraph container
       * @returns {void}
       */function fetchTrafficDisruptions($disruptionsContainer){// eslint-disable-next-line max-len
var $errorMessage="<div class=\"uk-alert-danger\" uk-alert>\n"+// eslint-disable-next-line max-len
"<a class=\"uk-alert-close\" uk-close></a>\n"+// eslint-disable-next-line max-len
"<p>"+Drupal.t("The website encountered an unexpected error. Please try again later.")+"</p>\n"+"</div>";var $ajaxLoaderTop=$(".js-ajax-loader-top");try{$.ajax({url:Drupal.url("getInfoTrafficHtml"),cache:false,success:function success(data){// eslint-disable-next-line no-console
updateDisruptionsContainer($disruptionsContainer,data);// Generate picto for line if needed
// eslint-disable-next-line max-len
var $trafficLineNumber=$(once("trafficLineNumber",".js-traffic-line-number",$disruptionsContainer.get(0)));$trafficLineNumber.each(function(){// eslint-disable-next-line max-len
$(this).attr("style",String("background-color: "+$(this).data("color")));});},beforeSend:function beforeSend(){$ajaxLoaderTop.removeClass("uk-hidden");},error:function error(){$disruptionsContainer.html($errorMessage);},complete:function complete(){$disruptionsContainer.slideDown("slow");$disruptionsContainer.removeClass("disruptions-container__list");$ajaxLoaderTop.addClass("uk-hidden");}});}catch(e){// eslint-disable-next-line max-len
$disruptionsContainer.html($errorMessage);}}// eslint-disable-next-line max-len
var $paragraphInfoTraffic=$(once("paragraphInfoTraffic",".paragraph--type--info-trafic",context));$paragraphInfoTraffic.each(function(){var $disruptionsContainer=$(this).find(".js-disruption-list");// Initial fetch
fetchTrafficDisruptions($disruptionsContainer);// Call the 'getDisruptions' method every X seconds
if(typeof settings.infoTrafic.checkDelay!=="undefined"&&settings.infoTrafic.checkDelay>0){setInterval(function(){fetchTrafficDisruptions($disruptionsContainer);},// Convert 'checkDelay' in milliseconds
settings.infoTrafic.checkDelay*1000);}});}};// eslint-disable-next-line no-undef
}(document,Drupal,jQuery);
//# sourceMappingURL=paragraph-info-trafic.js.map
